import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type Db, type Tx, withTx } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import type { AuthVariables } from "./auth";
import { ApiError } from "./errors";

// Idempotency-Key handling for every POST under /v1.
//
// - The key row is claimed (in_progress) before the handler runs.
// - Handlers that change state call idempotentTx(), which stores the
//   response in the SAME transaction as the change. A crash can never leave
//   a committed change without its stored response, so a stale in_progress
//   key means nothing was committed and the request can safely run again.
// - Responses the handler didn't store (validation and other 4xx errors)
//   are stored afterwards. 5xx responses release the key so the client can
//   retry.

export const IDEMPOTENCY_TTL_HOURS = 24;
const STALE_IN_PROGRESS_SECONDS = 60;
const MAX_KEY_LENGTH = 255;

type Scope = { merchantId: string; livemode: boolean; key: string };
type IdempotencyState = Scope & { saved: boolean };

export type IdempotencyVariables = AuthVariables & {
  idempotency: IdempotencyState;
};

type ClaimResult =
  | { kind: "new" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "mismatch" }
  | { kind: "in_progress" };

const where = (s: Scope) =>
  and(
    eq(idempotencyKeys.merchantId, s.merchantId),
    eq(idempotencyKeys.livemode, s.livemode),
    eq(idempotencyKeys.key, s.key),
  );

async function claim(db: Db, scope: Scope, hash: Buffer): Promise<ClaimResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ ...scope, requestHash: hash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length > 0) return { kind: "new" };

    const [row] = await db
      .select({
        requestHash: idempotencyKeys.requestHash,
        status: idempotencyKeys.status,
        responseStatus: idempotencyKeys.responseStatus,
        responseBody: idempotencyKeys.responseBody,
        expired: sql<boolean>`${idempotencyKeys.createdAt} < now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`,
        stale: sql<boolean>`${idempotencyKeys.createdAt} < now() - make_interval(secs => ${STALE_IN_PROGRESS_SECONDS})`,
      })
      .from(idempotencyKeys)
      .where(where(scope));
    if (!row) continue; // deleted concurrently: try to insert again

    if (row.expired || (row.status === "in_progress" && row.stale)) {
      await db.delete(idempotencyKeys).where(where(scope));
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

async function store(
  db: Db | Tx,
  scope: Scope,
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
    .where(where(scope));
}

export function idempotency(deps: { db: Db }) {
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
        return c.json(result.body, result.status as ContentfulStatusCode);
      }

      const state: IdempotencyState = { ...scope, saved: false };
      c.set("idempotency", state);
      await next();
      if (state.saved) return;

      if (c.res.status >= 500) {
        await deps.db.delete(idempotencyKeys).where(where(scope));
      } else {
        await store(deps.db, scope, c.res.status, await c.res.clone().json());
      }
    },
  );
}

/**
 * Runs a state-changing handler body and stores its response in the same
 * transaction. Returns the body for the handler to send.
 */
export async function idempotentTx<T>(
  c: Context<{ Variables: IdempotencyVariables }>,
  db: Db,
  status: ContentfulStatusCode,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const state = c.get("idempotency");
  const body = await withTx(db, async (tx) => {
    const result = await fn(tx);
    await store(tx, state, status, result);
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
