import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { must } from "../../test/assert";
import { createTestDb } from "../../test/db";
import { createTestMerchant, testAppDeps, testKeys } from "../../test/fixtures";
import { railQueue, SIMULATED_ALIASES, SIMULATED_RAIL } from "../connectors";
import { drain } from "../jobs";
import { newId } from "../lib/ids";
import { EVENTS_QUEUE } from "../modules/events";
import { createApiKey } from "../modules/merchants";
import { railJobHandlers } from "../modules/payments";
import {
  eventDispatchHandlers,
  MAX_ENDPOINTS_PER_MODE,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
  WEBHOOKS_QUEUE,
  webhookJobHandlers,
} from "../modules/webhooks";
import { createApp } from "./app";

// Test-only: responses are asserted structurally, so loose typing is intended.
// biome-ignore lint/suspicious/noExplicitAny: see above
type Json = Record<string, any>;

const received: { body: string; signature: string | null }[] = [];
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    received.push({
      body: await req.text(),
      signature: req.headers.get(SIGNATURE_HEADER),
    });
    return new Response(null, { status: 204 });
  },
});
const receiverUrl = `http://localhost:${receiver.port}/hooks`;

let t: Awaited<ReturnType<typeof createTestDb>>;
let deps: ReturnType<typeof testAppDeps>;
let app: ReturnType<typeof createApp>;
const keys = testKeys();

beforeAll(async () => {
  t = await createTestDb();
  deps = testAppDeps(t.db, keys);
  app = createApp(deps);
});

afterAll(async () => {
  receiver.stop(true);
  await t.drop();
});

async function newMerchantKey(livemode = false) {
  const m = await createTestMerchant(t.db);
  return (await createApiKey(t.db, keys, { merchantId: m.id, livemode }))
    .secret;
}

async function call(key: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST") headers["idempotency-key"] = newId();
  const res = await app.request(`/v1${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { res, body: (await res.json()) as Json };
}

const runAll = async () => {
  for (let i = 0; i < 3; i++) {
    await drain(
      t.db,
      railQueue(SIMULATED_RAIL),
      railJobHandlers(t.db, deps.payments),
    );
    await drain(t.db, EVENTS_QUEUE, eventDispatchHandlers(t.db));
    await drain(t.db, WEBHOOKS_QUEUE, webhookJobHandlers(t.db, deps.webhooks));
  }
};

describe("webhook endpoints API", () => {
  test("create returns the secret once; retrieve and list never do", async () => {
    const key = await newMerchantKey();
    const created = await call(key, "POST", "/webhook_endpoints", {
      url: receiverUrl,
      enabled_events: ["payment_intent.succeeded"],
      description: "orders",
    });
    expect(created.res.status).toBe(200);
    expect(created.body).toMatchObject({
      object: "webhook_endpoint",
      livemode: false,
      url: receiverUrl,
      enabled_events: ["payment_intent.succeeded"],
      description: "orders",
    });
    expect(created.body.id).toMatch(/^we_/);
    expect(created.body.secret).toMatch(/^whsec_/);

    const got = await call(key, "GET", `/webhook_endpoints/${created.body.id}`);
    expect(got.body.id).toBe(created.body.id);
    expect(got.body.secret).toBeUndefined();

    const list = await call(key, "GET", "/webhook_endpoints");
    expect(list.body.data.map((e: Json) => e.id)).toEqual([created.body.id]);
    expect(list.body.data[0].secret).toBeUndefined();
  });

  test("validation: unknown event types, empty list, bad URLs", async () => {
    const key = await newMerchantKey();
    const bad = [
      { url: receiverUrl, enabled_events: ["payment_intent.nope"] },
      { url: receiverUrl, enabled_events: [] },
      { url: "not a url", enabled_events: ["*"] },
      { url: "ftp://example.com", enabled_events: ["*"] },
    ];
    for (const body of bad) {
      const { res, body: err } = await call(
        key,
        "POST",
        "/webhook_endpoints",
        body,
      );
      expect(res.status).toBe(400);
      expect(err.error.type).toBe("invalid_request_error");
    }
  });

  test("live mode requires https", async () => {
    const key = await newMerchantKey(true);
    const { res, body } = await call(key, "POST", "/webhook_endpoints", {
      url: receiverUrl,
      enabled_events: ["*"],
    });
    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({ code: "url_invalid", param: "url" });
  });

  test(`limit of ${MAX_ENDPOINTS_PER_MODE} endpoints per mode`, async () => {
    const key = await newMerchantKey();
    for (let i = 0; i < MAX_ENDPOINTS_PER_MODE; i++) {
      await call(key, "POST", "/webhook_endpoints", {
        url: receiverUrl,
        enabled_events: ["*"],
      });
    }
    const { res, body } = await call(key, "POST", "/webhook_endpoints", {
      url: receiverUrl,
      enabled_events: ["*"],
    });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("too_many_webhook_endpoints");
  });

  test("delete, then 404; other merchants can't see or delete", async () => {
    const key = await newMerchantKey();
    const other = await newMerchantKey();
    const { body: ep } = await call(key, "POST", "/webhook_endpoints", {
      url: receiverUrl,
      enabled_events: ["*"],
    });
    expect(
      (await call(other, "GET", `/webhook_endpoints/${ep.id}`)).res.status,
    ).toBe(404);
    expect(
      (await call(other, "DELETE", `/webhook_endpoints/${ep.id}`)).res.status,
    ).toBe(404);

    const del = await call(key, "DELETE", `/webhook_endpoints/${ep.id}`);
    expect(del.body).toEqual({
      id: ep.id,
      object: "webhook_endpoint",
      deleted: true,
    });
    expect(
      (await call(key, "GET", `/webhook_endpoints/${ep.id}`)).res.status,
    ).toBe(404);
  });
});

describe("end to end: payment → signed webhook → events API", () => {
  test("a succeeded payment is delivered, verifiable, and listed", async () => {
    const key = await newMerchantKey();
    const { body: ep } = await call(key, "POST", "/webhook_endpoints", {
      url: receiverUrl,
      enabled_events: ["payment_intent.succeeded"],
    });
    const { body: pi } = await call(key, "POST", "/payment_intents", {
      amount: 75_000,
      currency: "SDG",
    });
    await call(key, "POST", `/payment_intents/${pi.id}/confirm`, {
      payer: { alias: SIMULATED_ALIASES.succeeds },
    });
    received.length = 0;
    await runAll();

    // Only the subscribed type was delivered, once, with a valid signature.
    expect(received).toHaveLength(1);
    const hook = must(received[0]);
    expect(
      verifyWebhookSignature(ep.secret, hook.body, must(hook.signature)),
    ).toBe(true);
    const event = JSON.parse(hook.body) as Json;
    expect(event).toMatchObject({
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: pi.id, status: "succeeded", amount: 75_000 } },
    });

    // The same event via the API.
    const got = await call(key, "GET", `/events/${event.id}`);
    expect(got.body).toEqual(event);

    // All lifecycle events are listed, newest first, and filterable.
    const list = await call(key, "GET", "/events?limit=10");
    expect(list.body.data.map((e: Json) => e.type)).toEqual([
      "payment_intent.succeeded",
      "payment_intent.processing",
      "payment_intent.created",
    ]);
    const filtered = await call(
      key,
      "GET",
      "/events?type=payment_intent.created",
    );
    expect(filtered.body.data.map((e: Json) => e.type)).toEqual([
      "payment_intent.created",
    ]);
  });

  test("events pagination and scoping", async () => {
    const key = await newMerchantKey();
    for (let i = 0; i < 3; i++) {
      await call(key, "POST", "/payment_intents", {
        amount: 100,
        currency: "SDG",
      });
    }
    const page1 = await call(key, "GET", "/events?limit=2");
    expect(page1.body.has_more).toBe(true);
    const page2 = await call(
      key,
      "GET",
      `/events?limit=2&starting_after=${page1.body.data[1].id}`,
    );
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.has_more).toBe(false);
    const ids = [...page1.body.data, ...page2.body.data].map((e: Json) => e.id);
    expect(new Set(ids).size).toBe(3);

    const other = await newMerchantKey();
    expect(
      (await call(other, "GET", `/events/${page1.body.data[0].id}`)).res.status,
    ).toBe(404);
    expect(
      (
        await call(
          other,
          "GET",
          `/events?starting_after=${page1.body.data[0].id}`,
        )
      ).res.status,
    ).toBe(404);
  });
});
