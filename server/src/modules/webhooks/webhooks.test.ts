import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { must } from "../../../test/assert";
import { createTestDb } from "../../../test/db";
import { createTestMerchant, testKeys } from "../../../test/fixtures";
import { pgErrorCode, withTx } from "../../db/client";
import { webhookDeliveries, webhookDeliveryAttempts } from "../../db/schema";
import { drain } from "../../jobs";
import { EVENTS_QUEUE, type PublishInput, pgEventBus } from "../events";
import type { Merchant } from "../merchants";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  dispatchEvent,
  eventDispatchHandlers,
  MAX_DELIVERY_ATTEMPTS,
  MAX_ENDPOINTS_PER_MODE,
  RETRY_SCHEDULE_SECONDS,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
  WEBHOOKS_QUEUE,
  type WebhookDeps,
  WebhookError,
  webhookJobHandlers,
} from ".";

// A real HTTP receiver on localhost. The status it returns is configurable.
type Received = { body: string; signature: string | null };
let received: Received[] = [];
let respondWith = 200;
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    received.push({
      body: await req.text(),
      signature: req.headers.get(SIGNATURE_HEADER),
    });
    return new Response("ok", { status: respondWith });
  },
});
const receiverUrl = `http://localhost:${receiver.port}/hooks`;

let t: Awaited<ReturnType<typeof createTestDb>>;
const keys = testKeys();
const deps: WebhookDeps = {
  keys,
  urlPolicy: { allowPrivate: true },
  timeoutMs: 2_000,
};

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  receiver.stop(true);
  await t.drop();
});

async function setup(enabledEvents = ["*"]) {
  received = [];
  respondWith = 200;
  const merchant = await createTestMerchant(t.db);
  const { endpoint, secret } = await createWebhookEndpoint(t.db, deps, {
    merchantId: merchant.id,
    livemode: false,
    url: receiverUrl,
    enabledEvents,
  });
  return { merchant, endpoint, secret };
}

async function publish(
  merchant: Merchant,
  type: PublishInput["type"] = "payment_intent.succeeded",
) {
  return withTx(t.db, (tx) =>
    pgEventBus.publish(tx, {
      type,
      merchantId: merchant.id,
      livemode: false,
      object: { id: "pi_x", object: "payment_intent" },
    }),
  );
}

const run = async () => {
  await drain(t.db, EVENTS_QUEUE, eventDispatchHandlers(t.db));
  await drain(t.db, WEBHOOKS_QUEUE, webhookJobHandlers(t.db, deps));
};

async function deliveriesFor(eventId: string) {
  return t.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.eventId, eventId));
}

describe("webhook endpoints", () => {
  test("the secret is returned once and stored encrypted", async () => {
    const { endpoint, secret } = await setup();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(endpoint.secretEncrypted.includes(Buffer.from(secret))).toBe(false);
    expect(keys.decrypt(endpoint.secretEncrypted)).toBe(secret);
  });

  test("URL policy is enforced at creation", async () => {
    const merchant = await createTestMerchant(t.db);
    const strict = { keys, urlPolicy: { allowPrivate: false } };
    for (const [url, livemode] of [
      ["http://127.0.0.1/x", false],
      ["http://example.com/x", true],
    ] as const) {
      const err = await createWebhookEndpoint(t.db, strict, {
        merchantId: merchant.id,
        livemode,
        url,
        enabledEvents: ["*"],
      }).catch((e) => e);
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).code).toBe("url_invalid");
    }
  });

  test(`at most ${MAX_ENDPOINTS_PER_MODE} endpoints per mode`, async () => {
    const merchant = await createTestMerchant(t.db);
    const make = () =>
      createWebhookEndpoint(t.db, deps, {
        merchantId: merchant.id,
        livemode: false,
        url: receiverUrl,
        enabledEvents: ["*"],
      });
    for (let i = 0; i < MAX_ENDPOINTS_PER_MODE; i++) await make();
    expect((await make().catch((e) => e)).code).toBe(
      "too_many_webhook_endpoints",
    );
  });
});

describe("dispatch and delivery", () => {
  test("delivers a signed event body the receiver can verify", async () => {
    const { merchant, secret } = await setup();
    const event = await publish(merchant);
    await run();

    expect(received).toHaveLength(1);
    const got = must(received[0]);
    expect(verifyWebhookSignature(secret, got.body, must(got.signature))).toBe(
      true,
    );
    expect(JSON.parse(got.body)).toMatchObject({
      object: "event",
      type: "payment_intent.succeeded",
      livemode: false,
      data: { object: { id: "pi_x" } },
    });

    const [delivery] = await deliveriesFor(event.id);
    expect(delivery).toMatchObject({
      status: "succeeded",
      attempts: 1,
      lastResponseStatus: 200,
    });
  });

  test("only subscribed endpoints receive an event", async () => {
    const { merchant } = await setup(["payment_intent.canceled"]);
    const event = await publish(merchant, "payment_intent.succeeded");
    await run();
    expect(received).toHaveLength(0);
    expect(await deliveriesFor(event.id)).toHaveLength(0);
  });

  test("other merchants' endpoints never receive the event", async () => {
    await setup();
    const other = await createTestMerchant(t.db);
    received = [];
    await publish(other);
    await run();
    expect(received).toHaveLength(0);
  });

  test("dispatching twice still delivers once", async () => {
    const { merchant } = await setup();
    const event = await publish(merchant);
    await run();
    await dispatchEvent(t.db, event.id);
    await run();
    expect(received).toHaveLength(1);
    expect(await deliveriesFor(event.id)).toHaveLength(1);
  });

  test("a failing endpoint is retried on schedule, then succeeds", async () => {
    const { merchant } = await setup();
    respondWith = 500;
    const event = await publish(merchant);
    await run();

    let [delivery] = await deliveriesFor(event.id);
    expect(delivery).toMatchObject({
      status: "pending",
      attempts: 1,
      lastResponseStatus: 500,
      lastError: "http_500",
    });
    const [job] = await t.sql`
      select extract(epoch from run_at - now())::int as delay from jobs
      where dedupe_key = ${`deliver_webhook:${must(delivery).id}`}`;
    expect(job?.delay).toBeGreaterThan(RETRY_SCHEDULE_SECONDS[0] - 5);
    expect(job?.delay).toBeLessThanOrEqual(RETRY_SCHEDULE_SECONDS[0]);

    respondWith = 204;
    await t.db.execute(
      sql`update jobs set run_at = now() where queue = 'webhooks'`,
    );
    await run();
    [delivery] = await deliveriesFor(event.id);
    expect(delivery).toMatchObject({ status: "succeeded", attempts: 2 });

    const attempts = await t.db
      .select()
      .from(webhookDeliveryAttempts)
      .where(eq(webhookDeliveryAttempts.deliveryId, must(delivery).id));
    expect(attempts.map((a) => a.responseStatus).sort()).toEqual([204, 500]);
  });

  test("gives up after the last attempt and marks the delivery failed", async () => {
    const { merchant } = await setup();
    respondWith = 503;
    const event = await publish(merchant);
    await drain(t.db, EVENTS_QUEUE, eventDispatchHandlers(t.db));
    // Jump to the final attempt.
    await t.db.execute(
      sql`update jobs set attempts = ${MAX_DELIVERY_ATTEMPTS - 1} where queue = 'webhooks' and status = 'pending'`,
    );
    await drain(t.db, WEBHOOKS_QUEUE, webhookJobHandlers(t.db, deps));
    const [delivery] = await deliveriesFor(event.id);
    expect(delivery).toMatchObject({ status: "failed", lastError: "http_503" });
  });

  test("redirects are not followed and count as failures", async () => {
    const redirector = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    });
    try {
      const merchant = await createTestMerchant(t.db);
      await createWebhookEndpoint(t.db, deps, {
        merchantId: merchant.id,
        livemode: false,
        url: `http://localhost:${redirector.port}/`,
        enabledEvents: ["*"],
      });
      const event = await publish(merchant);
      await run();
      const [delivery] = await deliveriesFor(event.id);
      expect(delivery).toMatchObject({
        status: "pending",
        lastResponseStatus: 302,
      });
    } finally {
      redirector.stop(true);
    }
  });

  test("a URL that became private is blocked at delivery time", async () => {
    const { merchant } = await setup();
    const strict: WebhookDeps = {
      ...deps,
      urlPolicy: { allowPrivate: false },
    };
    const event = await publish(merchant);
    await drain(t.db, EVENTS_QUEUE, eventDispatchHandlers(t.db));
    await drain(t.db, WEBHOOKS_QUEUE, webhookJobHandlers(t.db, strict));
    expect(received).toHaveLength(0);
    const [delivery] = await deliveriesFor(event.id);
    expect(delivery?.lastError).toStartWith("url_blocked");
  });

  test("deleted endpoints stop receiving", async () => {
    const { merchant, endpoint } = await setup();
    await deleteWebhookEndpoint(
      t.db,
      { merchantId: merchant.id, livemode: false },
      endpoint.id,
    );
    await publish(merchant);
    await run();
    expect(received).toHaveLength(0);
  });

  test("the attempt log is append-only", async () => {
    const { merchant } = await setup();
    await publish(merchant);
    await run();
    try {
      await t.sql`update webhook_delivery_attempts set error = 'x'`;
      throw new Error("expected TA001");
    } catch (err) {
      expect(pgErrorCode(err)).toBe("TA001");
    }
  });
});
