import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { must } from "../../test/assert";
import { createTestDb } from "../../test/db";
import {
  createTestMerchant,
  testAppDeps,
  testKeys,
  testPaymentsDeps,
} from "../../test/fixtures";
import { railQueue, SIMULATED_ALIASES, SIMULATED_RAIL } from "../connectors";
import { drain } from "../jobs";
import { newId } from "../lib/ids";
import { chart, ensureAccount, getBalance } from "../modules/ledger";
import { createApiKey, type Merchant } from "../modules/merchants";
import { railJobHandlers } from "../modules/payments";
import { createApp } from "./app";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let deps: ReturnType<typeof testPaymentsDeps>;
const keys = testKeys();

let merchant: Merchant;
let testKey: string;
let liveKey: string;

beforeAll(async () => {
  t = await createTestDb();
  deps = testPaymentsDeps(t.db);
  app = createApp({ ...testAppDeps(t.db, keys), payments: deps });
  merchant = await createTestMerchant(t.db, {
    pricing: { feeBps: 100, feeFixed: 0n, feeMin: null, feeMax: null },
  });
  testKey = (
    await createApiKey(t.db, keys, { merchantId: merchant.id, livemode: false })
  ).secret;
  liveKey = (
    await createApiKey(t.db, keys, { merchantId: merchant.id, livemode: true })
  ).secret;
});

afterAll(async () => {
  await t.drop();
});

// Test-only: responses are asserted structurally, so loose typing is intended.
// biome-ignore lint/suspicious/noExplicitAny: see above
type Json = Record<string, any>;

async function call(
  method: string,
  path: string,
  options: { body?: unknown; key?: string; idem?: string | null } = {},
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.key ?? testKey}`,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST" && options.idem !== null) {
    headers["idempotency-key"] = options.idem ?? newId();
  }
  const res = await app.request(`/v1${path}`, {
    method,
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  return { res, body: (await res.json()) as Json };
}

const createIntent = (body: Json = {}, options = {}) =>
  call("POST", "/payment_intents", {
    body: { amount: 150_000, currency: "SDG", ...body },
    ...options,
  });

const runRail = () =>
  drain(t.db, railQueue(SIMULATED_RAIL), railJobHandlers(t.db, deps));

describe("POST /v1/payment_intents", () => {
  test("creates a payment intent with the documented shape", async () => {
    const { res, body } = await createIntent({
      description: "Order 1042",
      merchant_reference: "1042",
      metadata: { cart: "abc" },
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      object: "payment_intent",
      livemode: false,
      status: "requires_confirmation",
      amount: 150_000,
      currency: "SDG",
      fee: null,
      description: "Order 1042",
      merchant_reference: "1042",
      metadata: { cart: "abc" },
      payer: null,
      latest_attempt: null,
      last_payment_error: null,
    });
    expect(body.id).toMatch(/^pi_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const ttl = Date.parse(body.expires_at) - Date.parse(body.created_at);
    expect(Math.round(ttl / 60_000)).toBe(15);
  });

  test("requires an Idempotency-Key", async () => {
    const { res, body } = await createIntent({}, { idem: null });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("idempotency_key_missing");
  });

  test("replays the stored response for a repeated key", async () => {
    const idem = newId();
    const first = await createIntent({}, { idem });
    const second = await createIntent({}, { idem });
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get("idempotent-replayed")).toBe("true");
    expect(second.body).toEqual(first.body);

    const list = await call("GET", "/payment_intents?limit=100");
    expect(
      list.body.data.filter((pi: Json) => pi.id === first.body.id),
    ).toHaveLength(1);
  });

  test("422 when a key is reused with a different request", async () => {
    const idem = newId();
    await createIntent({ amount: 100 }, { idem });
    const { res, body } = await createIntent({ amount: 200 }, { idem });
    expect(res.status).toBe(422);
    expect(body.error).toMatchObject({
      type: "idempotency_error",
      code: "idempotency_key_reused",
    });
  });

  test("409 while the original request is still in progress", async () => {
    const idem = newId();
    const raw = JSON.stringify({ amount: 100, currency: "SDG" });
    const { createHash } = await import("node:crypto");
    await t.sql`insert into idempotency_keys (merchant_id, livemode, key, claim_token, request_hash)
      values (${merchant.id}, false, ${idem}, gen_random_uuid(),
              ${createHash("sha256").update(`POST\n/v1/payment_intents\n${raw}`).digest()})`;
    const res = await app.request("/v1/payment_intents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testKey}`,
        "content-type": "application/json",
        "idempotency-key": idem,
      },
      body: raw,
    });
    expect(res.status).toBe(409);
  });

  test("validation errors name the parameter", async () => {
    const cases: [Json, string][] = [
      [{ amount: -5 }, "amount"],
      [{ amount: 1.5 }, "amount"],
      [{ currency: "USD" }, "currency"],
      [{ metadata: { k: 1 } }, "metadata.k"],
      [{ surprise: true }, ""],
    ];
    for (const [patch, param] of cases) {
      const { res, body } = await createIntent(patch);
      expect(res.status).toBe(400);
      expect(body.error.type).toBe("invalid_request_error");
      if (param) expect(body.error.param).toBe(param);
    }
    const missing = await call("POST", "/payment_intents", {
      body: { currency: "SDG" },
    });
    expect(missing.body.error).toMatchObject({
      code: "parameter_missing",
      param: "amount",
    });
  });

  test("expires_at must be 1 minute to 7 days ahead", async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    for (const ms of [30_000, 8 * 24 * 3600_000]) {
      const { res, body } = await createIntent({ expires_at: at(ms) });
      expect(res.status).toBe(400);
      expect(body.error.param).toBe("expires_at");
    }
    const ok = await createIntent({ expires_at: at(3600_000) });
    expect(ok.res.status).toBe(200);
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const res = await app.request("/v1/payment_intents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testKey}`,
        "content-type": "application/json",
        "idempotency-key": newId(),
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/payment_intents", () => {
  test("retrieve is scoped to merchant and mode", async () => {
    const { body: created } = await createIntent();
    expect((await call("GET", `/payment_intents/${created.id}`)).body.id).toBe(
      created.id,
    );

    const live = await call("GET", `/payment_intents/${created.id}`, {
      key: liveKey,
    });
    expect(live.res.status).toBe(404);

    const other = await createTestMerchant(t.db);
    const otherKey = (
      await createApiKey(t.db, keys, { merchantId: other.id, livemode: false })
    ).secret;
    const cross = await call("GET", `/payment_intents/${created.id}`, {
      key: otherKey,
    });
    expect(cross.res.status).toBe(404);
    expect(cross.body.error.code).toBe("payment_intent_not_found");
  });

  test("malformed IDs are a 404", async () => {
    for (const id of ["nope", "evt_01JDZ8Q0Y3M7S5K2V4T6W8X0YZ"]) {
      expect((await call("GET", `/payment_intents/${id}`)).res.status).toBe(
        404,
      );
    }
  });

  test("list paginates with starting_after", async () => {
    const m = await createTestMerchant(t.db);
    const key = (
      await createApiKey(t.db, keys, { merchantId: m.id, livemode: false })
    ).secret;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await createIntent({}, { key })).body.id);
    }
    // Public IDs are Crockford base32 ULIDs: lexicographic = ID order.
    // (Same-millisecond IDs have random suffixes; don't assume insertion order.)
    const sorted = [...ids].sort().reverse();
    const page1 = await call("GET", "/payment_intents?limit=2", { key });
    expect(page1.body).toMatchObject({ object: "list", has_more: true });
    expect(page1.body.data.map((p: Json) => p.id)).toEqual(sorted.slice(0, 2));
    const page2 = await call(
      "GET",
      `/payment_intents?limit=2&starting_after=${page1.body.data[1].id}`,
      { key },
    );
    expect(page2.body.data.map((p: Json) => p.id)).toEqual(sorted.slice(2));
    expect(page2.body.has_more).toBe(false);

    const bad = await call("GET", "/payment_intents?limit=500", { key });
    expect(bad.res.status).toBe(400);
  });
});

describe("confirm and cancel", () => {
  test("end to end: confirm, rail confirms, fee and ledger", async () => {
    const m = await createTestMerchant(t.db, {
      pricing: { feeBps: 100, feeFixed: 0n, feeMin: null, feeMax: null },
    });
    const key = (
      await createApiKey(t.db, keys, { merchantId: m.id, livemode: false })
    ).secret;
    const { body: created } = await createIntent({ amount: 250_000 }, { key });

    const confirmed = await call(
      "POST",
      `/payment_intents/${created.id}/confirm`,
      { key, body: { payer: { alias: SIMULATED_ALIASES.succeeds } } },
    );
    expect(confirmed.res.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: "processing",
      payer: { alias: SIMULATED_ALIASES.succeeds },
      latest_attempt: { status: "pending", rail: "simulated" },
    });
    expect(confirmed.body.latest_attempt.id).toMatch(/^pa_/);

    await runRail();

    const { body: paid } = await call("GET", `/payment_intents/${created.id}`, {
      key,
    });
    expect(paid).toMatchObject({
      status: "succeeded",
      fee: 2_500,
      latest_attempt: { status: "succeeded" },
    });
    expect(paid.succeeded_at).not.toBeNull();

    const receivable = await ensureAccount(
      t.db,
      chart.feesReceivable(m.id),
      false,
    );
    expect(await getBalance(t.db, receivable.id)).toBe(2_500n);
  });

  test("payer alias must be a Sudanese phone number", async () => {
    const { body: created } = await createIntent();
    const { res, body } = await call(
      "POST",
      `/payment_intents/${created.id}/confirm`,
      { body: { payer: { alias: "0912345678" } } },
    );
    expect(res.status).toBe(400);
    expect(body.error.param).toBe("payer.alias");
  });

  test("confirming twice is an unexpected_state error (with a new key)", async () => {
    const { body: created } = await createIntent();
    const path = `/payment_intents/${created.id}/confirm`;
    const body = { payer: { alias: SIMULATED_ALIASES.noResponse } };
    expect((await call("POST", path, { body })).res.status).toBe(200);
    const again = await call("POST", path, { body });
    expect(again.res.status).toBe(400);
    expect(again.body.error.code).toBe("payment_intent_unexpected_state");
  });

  test("live mode returns 503 rail_unavailable and releases the key", async () => {
    const idem = newId();
    const { body: created } = await createIntent({}, { key: liveKey });
    const path = `/payment_intents/${created.id}/confirm`;
    const body = { payer: { alias: SIMULATED_ALIASES.succeeds } };
    const first = await call("POST", path, { key: liveKey, body, idem });
    expect(first.res.status).toBe(503);
    expect(first.body.error.code).toBe("rail_unavailable");
    // 5xx responses aren't stored: the same key can be retried.
    const retry = await call("POST", path, { key: liveKey, body, idem });
    expect(retry.res.headers.get("idempotent-replayed")).toBeNull();
  });

  test("cancel", async () => {
    const { body: created } = await createIntent();
    const { res, body } = await call(
      "POST",
      `/payment_intents/${created.id}/cancel`,
    );
    expect(res.status).toBe(200);
    expect(body.status).toBe("canceled");
    expect(body.canceled_at).not.toBeNull();
  });

  test("a stored 4xx is replayed for the same key", async () => {
    const idem = newId();
    const { body: created } = await createIntent();
    const path = `/payment_intents/${created.id}/cancel`;
    await call("POST", path);
    const first = await call("POST", path, { idem });
    expect(first.res.status).toBe(400);
    const replay = await call("POST", path, { idem });
    expect(replay.res.status).toBe(400);
    expect(replay.res.headers.get("idempotent-replayed")).toBe("true");
    expect(must(replay.body.error).code).toBe(
      "payment_intent_unexpected_state",
    );
  });
});

describe("OpenAPI", () => {
  test("/v1/openapi.json is public and documents the routes", async () => {
    const res = await app.request("/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Json;
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/payment_intents",
        "/payment_intents/{id}",
        "/payment_intents/{id}/cancel",
        "/payment_intents/{id}/confirm",
      ]),
    );
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(doc.components.schemas.PaymentIntent).toBeDefined();
  });
});
