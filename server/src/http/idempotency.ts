import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { KeyProvider } from "../crypto/keys";
import { type Db, type Tx, withTx } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { newId } from "../lib/ids";
import type { AuthVariables } from "./auth";
import { ApiError } from "./errors";

// Idempotency-Key handling for every POST under /v1.
//
// - Each request claims the key row (in_progress) with its own claim_token
//   before the handler runs.
// - State-changing handlers call idempotentTx(). Inside the business
//   transaction it first locks its own claim row (FOR UPDATE, matching the
//   token), then runs the change, then stores the response in that same
//   transaction. If the claim was taken over, the request aborts before
//   changing anything.
// - A takeover (stale in_progress or expired row) deletes only the exact
//   claim it inspected, and only if it's still eligible, re-checked in SQL.
//   While the owner's transaction holds the row lock, that delete waits;
//   once the owner commits, the row is completed and is replayed, not
//   taken over. So elapsed time alone never lets two owners both commit.
// - Responses the handler didn't store (validation and other 4xx errors)
//   are stored afterwards. 5xx responses release the key so the client can
//   retry.
// - Secret fields (e.g. a webhook signing secret) are stored encrypted in
//   response_body and only decrypted when replayed.

export const IDEMPOTENCY_TTL_HOURS = 24;
const STALE_IN_PROGRESS_SECONDS = 60;
const MAX_KEY_LENGTH = 255;

type Scope = { merchantId: string; livemode: boolean; key: string };
type Claim = Scope & { claimToken: string };
type IdempotencyState = Claim & { saved: boolean };

export type IdempotencyVariables = AuthVariables & {
  idempotency: IdempotencyState;
};

type IdempotencyDeps = { db: Db; keys: KeyProvider };

type ClaimResult =
  | { kind: "new"; claimToken: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "mismatch" }
  | { kind: "in_progress" };

const whereScope = (s: Scope) =>
  and(
    eq(idempotencyKeys.merchantId, s.merchantId),
    eq(idempotencyKeys.livemode, s.livemode),
    eq(idempotencyKeys.key, s.key),
  );

const whereClaim = (c: Claim) =>
  and(whereScope(c), eq(idempotencyKeys.claimToken, c.claimToken));

const expiredSql = sql`${idempotencyKeys.createdAt} < now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`;
const staleInProgressSql = sql`(${idempotencyKeys.status} = 'in_progress' AND ${idempotencyKeys.createdAt} < now() - make_interval(secs => ${STALE_IN_PROGRESS_SECONDS}))`;

async function claim(db: Db, scope: Scope, hash: Buffer): Promise<ClaimResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimToken = newId();
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ ...scope, requestHash: hash, claimToken })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length > 0) return { kind: "new", claimToken };

    const [row] = await db
      .select({
        claimToken: idempotencyKeys.claimToken,
        requestHash: idempotencyKeys.requestHash,
        status: idempotencyKeys.status,
        responseStatus: idempotencyKeys.responseStatus,
        responseBody: idempotencyKeys.responseBody,
        reclaimable: sql<boolean>`(${expiredSql} OR ${staleInProgressSql})`,
      })
      .from(idempotencyKeys)
      .where(whereScope(scope));
    if (!row) continue; // deleted concurrently: try to insert again

    if (row.reclaimable) {
      // Delete exactly the claim we inspected, and only if it's still
      // eligible. If its owner is mid-transaction this waits for the row
      // lock; if the row changed meanwhile nothing is deleted, and the
      // loop re-inspects the current row.
      await db
        .delete(idempotencyKeys)
        .where(
          and(
            whereClaim({ ...scope, claimToken: row.claimToken }),
            sql`(${expiredSql} OR ${staleInProgressSql})`,
          ),
        );
      continue;
    }
    if (!row.requestHash.equals(hash)) return { kind: "mismatch" };
    if (row.status === "in_progress") return { kind: "in_progress" };
    return {
      kind: "replay",
      status: row.responseStatus ?? 200,
      body: row.responseBody,
    };
  }
  return { kind: "in_progress" };
}

// --- Secret fields ------------------------------------------------------------

const ENCRYPTED = "$encrypted";

function sealFields(
  body: unknown,
  fields: readonly string[],
  keys: KeyProvider,
): unknown {
  if (fields.length === 0 || !body || typeof body !== "object") return body;
  const sealed: Record<string, unknown> = {
    ...(body as Record<string, unknown>),
  };
  for (const field of fields) {
    if (sealed[field] === undefined) continue;
    sealed[field] = {
      [ENCRYPTED]: keys
        .encrypt(JSON.stringify(sealed[field]))
        .toString("base64"),
    };
  }
  return sealed;
}

function unsealFields(body: unknown, keys: KeyProvider): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const enc =
      v && typeof v === "object" && ENCRYPTED in v
        ? (v as Record<string, unknown>)[ENCRYPTED]
        : undefined;
    out[k] =
      typeof enc === "string"
        ? JSON.parse(keys.decrypt(Buffer.from(enc, "base64")))
        : v;
  }
  return out;
}

// --- Storage --------------------------------------------------------------------

async function store(
  db: Db | Tx,
  claimRef: Claim,
  status: number,
  body: unknown,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({
      status: "completed",
      responseStatus: status,
      responseBody: body,
      completedAt: sql`now()`,
    })
    .where(
      and(whereClaim(claimRef), eq(idempotencyKeys.status, "in_progress")),
    );
}

const claimLost = () =>
  new ApiError(
    409,
    "idempotency_error",
    "idempotency_request_in_progress",
    "This request's Idempotency-Key was taken over by a retry; no changes were made.",
  );

export function idempotency(deps: IdempotencyDeps) {
  return createMiddleware<{ Variables: IdempotencyVariables }>(
    async (c, next) => {
      if (c.req.method !== "POST") return next();

      const key = c.req.header("idempotency-key");
      if (!key) {
        throw new ApiError(
          400,
          "invalid_request_error",
          "idempotency_key_missing",
          "POST requests require an `Idempotency-Key` header.",
        );
      }
      if (key.length > MAX_KEY_LENGTH) {
        throw new ApiError(
          400,
          "invalid_request_error",
          "idempotency_key_invalid",
          `Idempotency keys can be at most ${MAX_KEY_LENGTH} characters.`,
        );
      }

      const body = await c.req.text();
      const hash = createHash("sha256")
        .update(`${c.req.method}\n${c.req.path}\n${body}`)
        .digest();
      const scope = {
        merchantId: c.var.merchant.id,
        livemode: c.var.livemode,
        key,
      };

      const result = await claim(deps.db, scope, hash);
      if (result.kind === "mismatch") {
        throw new ApiError(
          422,
          "idempotency_error",
          "idempotency_key_reused",
          "This Idempotency-Key was already used with a different request.",
        );
      }
      if (result.kind === "in_progress") {
        throw new ApiError(
          409,
          "idempotency_error",
          "idempotency_request_in_progress",
          "A request with this Idempotency-Key is still in progress.",
        );
      }
      if (result.kind === "replay") {
        c.header("Idempotent-Replayed", "true");
        return c.json(
          unsealFields(result.body, deps.keys),
          result.status as ContentfulStatusCode,
        );
      }

      const state: IdempotencyState = {
        ...scope,
        claimToken: result.claimToken,
        saved: false,
      };
      c.set("idempotency", state);
      await next();
      if (state.saved) return;

      if (c.res.status >= 500) {
        await deps.db.delete(idempotencyKeys).where(whereClaim(state));
      } else {
        await store(deps.db, state, c.res.status, await c.res.clone().json());
      }
    },
  );
}

/**
 * Runs a state-changing handler body and stores its response in the same
 * transaction, after confirming this request still owns its claim.
 * `secretFields` are top-level response fields stored encrypted.
 */
export async function idempotentTx<T>(
  c: Context<{ Variables: IdempotencyVariables }>,
  deps: IdempotencyDeps,
  status: ContentfulStatusCode,
  fn: (tx: Tx) => Promise<T>,
  options: { secretFields?: readonly string[] } = {},
): Promise<T> {
  const state = c.get("idempotency");
  const body = await withTx(deps.db, async (tx) => {
    const [owned] = await tx
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(and(whereClaim(state), eq(idempotencyKeys.status, "in_progress")))
      .for("update");
    if (!owned) throw claimLost();

    const result = await fn(tx);
    await store(
      tx,
      state,
      status,
      sealFields(result, options.secretFields ?? [], deps.keys),
    );
    return result;
  });
  state.saved = true;
  return body;
}

/** Deletes idempotency keys past their TTL. */
export async function pruneIdempotencyKeys(db: Db): Promise<number> {
  const rows = await db
    .delete(idempotencyKeys)
    .where(
      lt(
        idempotencyKeys.createdAt,
        sql`now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`,
      ),
    )
    .returning({ key: idempotencyKeys.key });
  return rows.length;
}
