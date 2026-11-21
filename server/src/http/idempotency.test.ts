import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { createTestDb } from "../../test/db";
import { createTestMerchant, testAppDeps, testKeys } from "../../test/fixtures";
import { newId } from "../lib/ids";
import { createApiKey, type Merchant } from "../modules/merchants";
import { createApp } from "./app";
import { ApiError } from "./errors";
import { type IdempotencyVariables, idempotentTx } from "./idempotency";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let deps: ReturnType<typeof testAppDeps>;
const keys = testKeys();
let merchant: Merchant;
let apiKey: string;

beforeAll(async () => {
  t = await createTestDb();
  deps = testAppDeps(t.db, keys);
  app = createApp(deps);
  merchant = await createTestMerchant(t.db);
  apiKey = (
    await createApiKey(t.db, keys, { merchantId: merchant.id, livemode: false })
  ).secret;
});

afterAll(async () => {
  await t.drop();
});

const BODY = JSON.stringify({ amount: 100, currency: "SDG" });
const hashOf = (path: string, body: string) =>
  createHash("sha256").update(`POST\n${path}\n${body}`).digest();

function post(path: string, idem: string, body = BODY) {
  return app.request(`/v1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": idem,
    },
    body,
  });
}

/** Inserts an in_progress claim that looks 2 minutes old (stale). */
async function staleClaim(idem: string, claimToken = newId()) {
  await t.sql`insert into idempotency_keys
      (merchant_id, livemode, key, claim_token, request_hash, created_at)
    values (${merchant.id}, false, ${idem}, ${claimToken},
            ${hashOf("/v1/payment_intents", BODY)}, now() - interval '2 minutes')`;
  return claimToken;
}

describe("stale-claim takeover", () => {
  test("waits for the owner's open transaction, then replays its response", async () => {
    const idem = newId();
    const token = await staleClaim(idem);

    // The original owner is mid-transaction, holding its claim row.
    const owner = await t.sql.reserve();
    let retry: Promise<Response> | Response;
    try {
      await owner`begin`;
      await owner`select 1 from idempotency_keys where claim_token = ${token} for update`;

      retry = post("/payment_intents", idem);
      await new Promise((r) => setTimeout(r, 100)); // the retry is now blocked

      await owner`update idempotency_keys
        set status = 'completed', response_status = 200,
            response_body = '{"owner":"original"}'::jsonb, completed_at = now()
        where claim_token = ${token}`;
      await owner`commit`;
    } finally {
      owner.release();
    }

    const res = await retry;
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(await res.json()).toEqual({ owner: "original" });
  });

  test("a stale claim with no live owner is taken over", async () => {
    const idem = newId();
    const token = await staleClaim(idem);
    const res = await post("/payment_intents", idem);
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    const [row] =
      await t.sql`select claim_token, status from idempotency_keys where key = ${idem}`;
    expect(row?.claim_token).not.toBe(token);
    expect(row?.status).toBe("completed");
  });

  test("a request whose claim was taken over can't commit its change", async () => {
    const idem = newId();
    await staleClaim(idem); // the current owner's claim
    const state = {
      merchantId: merchant.id,
      livemode: false,
      key: idem,
      claimToken: newId(), // a previous owner's (lost) claim
      saved: false,
    };
    const c = { get: () => state } as unknown as Context<{
      Variables: IdempotencyVariables;
    }>;
    let ran = false;
    const err = await idempotentTx(c, deps, 200, async () => {
      ran = true;
      return {};
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect(ran).toBe(false);
  });
});

describe("secret fields", () => {
  test("a webhook secret is stored encrypted and replayed decrypted", async () => {
    const idem = newId();
    const body = JSON.stringify({
      url: "http://localhost:9/hooks",
      enabled_events: ["*"],
    });
    const first = await post("/webhook_endpoints", idem, body);
    const created = (await first.json()) as { secret: string };
    expect(created.secret).toMatch(/^whsec_/);

    const [row] = await t.sql`
      select response_body::text as stored, response_body->'secret' ? '$encrypted' as sealed
      from idempotency_keys where key = ${idem}`;
    expect(row?.sealed).toBe(true);
    expect(String(row?.stored)).not.toContain(created.secret);

    const replay = await post("/webhook_endpoints", idem, body);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(created);
  });
});
