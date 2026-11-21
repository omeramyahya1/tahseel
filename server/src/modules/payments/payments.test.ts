import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { must } from "../../../test/assert";
import { createTestDb } from "../../../test/db";
import { createTestMerchant } from "../../../test/fixtures";
import {
  createRailRegistry,
  createSimulatedRail,
  railQueue,
  SIMULATED_ALIASES,
  SIMULATED_RAIL,
} from "../../connectors";
import { pgErrorCode, withTx } from "../../db/client";
import { events, paymentAttempts } from "../../db/schema";
import { drain } from "../../jobs";
import { pgEventBus } from "../events";
import { chart, ensureAccount, getBalance } from "../ledger";
import type { Merchant } from "../merchants";
import {
  applyRailStatus,
  cancelPaymentIntent,
  confirmPaymentIntent,
  createPaymentIntent,
  expireDuePaymentIntents,
  getPaymentIntent,
  listPaymentIntents,
  PaymentError,
  type PaymentErrorCode,
  type PaymentsDeps,
  presentPaymentIntent,
  railJobHandlers,
} from ".";

let t: Awaited<ReturnType<typeof createTestDb>>;
let deps: PaymentsDeps;
let merchant: Merchant;

beforeAll(async () => {
  t = await createTestDb();
  deps = {
    bus: pgEventBus,
    rails: createRailRegistry({
      test: createSimulatedRail({ db: t.db, responseDelayMs: 0 }),
      live: null,
    }),
  };
  merchant = await createTestMerchant(t.db, {
    pricing: { feeBps: 150, feeFixed: 100n, feeMin: null, feeMax: null },
  });
});

afterAll(async () => {
  await t.drop();
});

const scope = (m: Merchant = merchant, livemode = false) => ({
  merchantId: m.id,
  livemode,
});

const runRail = () =>
  drain(t.db, railQueue(SIMULATED_RAIL), railJobHandlers(t.db, deps));

async function create(amount = 1_000_000n, extra = {}, s = scope()) {
  return withTx(t.db, (tx) =>
    createPaymentIntent(tx, deps, { ...s, amount, ...extra }),
  );
}

async function confirm(id: string, payerAlias: string, s = scope()) {
  return withTx(t.db, (tx) =>
    confirmPaymentIntent(tx, deps, { ...s, id, payerAlias }),
  );
}

async function reload(id: string, s = scope()) {
  return must(await getPaymentIntent(t.db, s, id), "payment intent");
}

async function eventTypes(publicId: string) {
  const rows = await t.db.select().from(events).orderBy(events.createdAt);
  return rows.filter((e) => e.data.object.id === publicId).map((e) => e.type);
}

async function balance(spec: Parameters<typeof ensureAccount>[1]) {
  return getBalance(t.db, (await ensureAccount(t.db, spec, false)).id);
}

async function expectSqlState(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (err) {
    expect(pgErrorCode(err)).toBe(code);
    return;
  }
  throw new Error(`expected SQLSTATE ${code}, but the operation succeeded`);
}

async function expectPaymentError(p: Promise<unknown>, code: PaymentErrorCode) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PaymentError);
    expect((err as PaymentError).code).toBe(code);
    return;
  }
  throw new Error(`expected PaymentError ${code}`);
}

describe("payment intent lifecycle", () => {
  test("create: requires_confirmation, 15-minute default expiry, created event", async () => {
    const before = Date.now();
    const { intent } = await create(50_000n, {
      description: "Order 42",
      merchantReference: "ord_42",
      metadata: { cart: "abc" },
    });
    expect(intent.status).toBe("requires_confirmation");
    expect(intent.fee).toBeNull();
    const ttl = intent.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(14.9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1_000);

    const again = await reload(intent.id);
    expect(again.intent.metadata).toEqual({ cart: "abc" });
    const publicId = presentPaymentIntent(again.intent, again.attempt).id;
    expect(await eventTypes(publicId)).toEqual(["payment_intent.created"]);
  });

  test("success: rail confirms, fee accrues, ledger posts, events in order", async () => {
    const m = await createTestMerchant(t.db, {
      pricing: { feeBps: 150, feeFixed: 100n, feeMin: null, feeMax: null },
    });
    const s = scope(m);
    const { intent } = await create(1_000_000n, {}, s);
    const confirmed = await confirm(intent.id, SIMULATED_ALIASES.succeeds, s);
    expect(confirmed.intent.status).toBe("processing");
    expect(confirmed.attempt?.status).toBe("pending");

    expect(await runRail()).toBe(2); // request_to_pay, then rail_status

    const done = await reload(intent.id, s);
    expect(done.intent.status).toBe("succeeded");
    expect(done.intent.fee).toBe(15_100n); // 1.5% of 1,000,000 + 100
    expect(done.intent.succeededAt).not.toBeNull();
    expect(done.attempt?.status).toBe("succeeded");
    expect(done.attempt?.railReference).toMatch(/^sim_/);

    expect(await balance(chart.merchantCollected(m.id))).toBe(1_000_000n);
    expect(await balance(chart.feesReceivable(m.id))).toBe(15_100n);

    const publicId = presentPaymentIntent(done.intent, done.attempt).id;
    expect(await eventTypes(publicId)).toEqual([
      "payment_intent.created",
      "payment_intent.processing",
      "payment_intent.succeeded",
    ]);
  });

  test("decline returns to requires_confirmation; retry with another alias succeeds", async () => {
    const { intent } = await create();
    await confirm(intent.id, SIMULATED_ALIASES.declines);
    await runRail();

    const declined = await reload(intent.id);
    expect(declined.intent.status).toBe("requires_confirmation");
    expect(declined.intent.lastPaymentError).toEqual({
      code: "payer_declined",
      message: "The payer declined the request.",
    });
    expect(declined.attempt?.status).toBe("declined");

    await confirm(intent.id, SIMULATED_ALIASES.succeeds);
    await runRail();
    const paid = await reload(intent.id);
    expect(paid.intent.status).toBe("succeeded");
    expect(paid.intent.lastPaymentError).toBeNull();

    const attempts = await t.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentIntentId, intent.id));
    expect(attempts.map((a) => a.status).sort()).toEqual([
      "declined",
      "succeeded",
    ]);
  });

  test("a rail rejection (unknown alias) is a decline with the rail's reason", async () => {
    const { intent } = await create();
    await confirm(intent.id, SIMULATED_ALIASES.unknownAlias);
    await runRail();
    const { intent: after, attempt } = await reload(intent.id);
    expect(after.status).toBe("requires_confirmation");
    expect(after.lastPaymentError?.code).toBe("alias_not_found");
    expect(attempt?.railReference).toBeNull();
  });

  test("no response: stays processing past expires_at until the rail reports expiry", async () => {
    const { intent } = await create(1_000n, {
      expiresAt: new Date(Date.now() + 1_200),
    });
    await confirm(intent.id, SIMULATED_ALIASES.noResponse);
    expect(await runRail()).toBe(1); // only request_to_pay is due

    await new Promise((r) => setTimeout(r, 1_300));
    // Our clock never expires a processing intent.
    await expireDuePaymentIntents(t.db, deps);
    expect((await reload(intent.id)).intent.status).toBe("processing");

    expect(await runRail()).toBe(1); // the rail's expiry report
    const { intent: after } = await reload(intent.id);
    expect(after.status).toBe("expired");
    expect(after.lastPaymentError?.code).toBe("request_expired");
  });

  test("expireDuePaymentIntents expires unconfirmed intents past expires_at", async () => {
    const { intent } = await create(1_000n, {
      expiresAt: new Date(Date.now() + 100),
    });
    await new Promise((r) => setTimeout(r, 150));
    await expectPaymentError(
      confirm(intent.id, SIMULATED_ALIASES.succeeds),
      "payment_intent_expired",
    );
    expect(await expireDuePaymentIntents(t.db, deps)).toBeGreaterThanOrEqual(1);
    const { intent: after } = await reload(intent.id);
    expect(after.status).toBe("expired");
    expect(after.expiredAt).not.toBeNull();
  });

  test("cancel, and no confirming or re-canceling afterwards", async () => {
    const { intent } = await create();
    const canceled = await withTx(t.db, (tx) =>
      cancelPaymentIntent(tx, deps, { ...scope(), id: intent.id }),
    );
    expect(canceled.intent.status).toBe("canceled");
    await expectPaymentError(
      withTx(t.db, (tx) =>
        cancelPaymentIntent(tx, deps, { ...scope(), id: intent.id }),
      ),
      "payment_intent_unexpected_state",
    );
    await expectPaymentError(
      confirm(intent.id, SIMULATED_ALIASES.succeeds),
      "payment_intent_unexpected_state",
    );
  });

  test("processing intents can't be canceled", async () => {
    const { intent } = await create();
    await confirm(intent.id, SIMULATED_ALIASES.noResponse);
    await expectPaymentError(
      withTx(t.db, (tx) =>
        cancelPaymentIntent(tx, deps, { ...scope(), id: intent.id }),
      ),
      "payment_intent_unexpected_state",
    );
  });

  test("concurrent confirms: exactly one wins", async () => {
    const { intent } = await create();
    const results = await Promise.allSettled([
      confirm(intent.id, SIMULATED_ALIASES.succeeds),
      confirm(intent.id, SIMULATED_ALIASES.succeeds),
      confirm(intent.id, SIMULATED_ALIASES.succeeds),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect((r.reason as PaymentError).code).toBe(
          "payment_intent_unexpected_state",
        );
      }
    }
  });

  test("a duplicate rail status report is a no-op (no double posting)", async () => {
    const m = await createTestMerchant(t.db);
    const s = scope(m);
    const { intent } = await create(5_000n, {}, s);
    const { attempt } = await confirm(intent.id, SIMULATED_ALIASES.succeeds, s);
    await runRail();
    const report = {
      rail: SIMULATED_RAIL,
      attemptId: must(attempt).id,
      railReference: "sim_dup",
      outcome: "succeeded" as const,
    };
    expect(await withTx(t.db, (tx) => applyRailStatus(tx, deps, report))).toBe(
      "duplicate",
    );
    expect(await balance(chart.merchantCollected(m.id))).toBe(5_000n);
  });

  test("a status for an unknown attempt is ignored", async () => {
    expect(
      await withTx(t.db, (tx) =>
        applyRailStatus(tx, deps, {
          rail: SIMULATED_RAIL,
          attemptId: "00000000-0000-0000-0000-000000000000",
          railReference: "x",
          outcome: "succeeded",
        }),
      ),
    ).toBe("unknown_attempt");
  });

  test("live mode has no rail yet", async () => {
    const { intent } = await create(1_000n, {}, scope(merchant, true));
    await expectPaymentError(
      confirm(intent.id, SIMULATED_ALIASES.succeeds, scope(merchant, true)),
      "rail_unavailable",
    );
  });
});

describe("scoping", () => {
  test("other merchants and the other mode can't see or touch an intent", async () => {
    const other = await createTestMerchant(t.db);
    const { intent } = await create();
    expect(await getPaymentIntent(t.db, scope(other), intent.id)).toBeNull();
    expect(
      await getPaymentIntent(t.db, scope(merchant, true), intent.id),
    ).toBeNull();
    await expectPaymentError(
      confirm(intent.id, SIMULATED_ALIASES.succeeds, scope(other)),
      "payment_intent_not_found",
    );
  });

  test("list paginates newest first", async () => {
    const m = await createTestMerchant(t.db);
    const s = scope(m);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create(100n, {}, s)).intent.id);
    await create(100n, {}, scope(m, true)); // other mode: not listed

    const page1 = await listPaymentIntents(t.db, s, { limit: 3 });
    expect(page1.data.map((r) => r.intent.id)).toEqual(ids.slice(2).reverse());
    expect(page1.hasMore).toBe(true);

    const page2 = await listPaymentIntents(t.db, s, {
      limit: 3,
      startingAfter: must(page1.data.at(-1)).intent.id,
    });
    expect(page2.data.map((r) => r.intent.id)).toEqual(
      ids.slice(0, 2).reverse(),
    );
    expect(page2.hasMore).toBe(false);
  });
});

describe("database invariants", () => {
  test("TP001: invalid status transitions are rejected", async () => {
    const { intent } = await create();
    await expectSqlState(
      t.sql`update payment_intents set status = 'succeeded', fee = 0 where id = ${intent.id}`,
      "TP001",
    );
    await t.sql`update payment_intents set status = 'canceled' where id = ${intent.id}`;
    await expectSqlState(
      t.sql`update payment_intents set status = 'requires_confirmation' where id = ${intent.id}`,
      "TP001",
    );
  });

  test("TP001: intents must be created as requires_confirmation", async () => {
    await expectSqlState(
      t.sql`insert into payment_intents (id, merchant_id, livemode, amount, currency, status, metadata, expires_at)
            values (gen_random_uuid(), ${merchant.id}, false, 100, 'SDG', 'succeeded', '{}', now() + interval '1 hour')`,
      "TP001",
    );
  });

  test("TP001: succeeded requires a fee", async () => {
    const { intent } = await create();
    await t.sql`update payment_intents set status = 'processing' where id = ${intent.id}`;
    await expectSqlState(
      t.sql`update payment_intents set status = 'succeeded' where id = ${intent.id}`,
      "TP001",
    );
  });

  test("TP002: amount, currency, mode, merchant and expiry are immutable", async () => {
    const { intent } = await create();
    for (const change of [
      t.sql`update payment_intents set amount = amount + 1 where id = ${intent.id}`,
      t.sql`update payment_intents set livemode = true where id = ${intent.id}`,
      t.sql`update payment_intents set expires_at = expires_at + interval '1 day' where id = ${intent.id}`,
    ]) {
      await expectSqlState(change, "TP002");
    }
  });

  test("intents, attempts and transitions can't be deleted", async () => {
    const { intent } = await create();
    await expectSqlState(
      t.sql`delete from payment_intents where id = ${intent.id}`,
      "TA001",
    );
    await expectSqlState(
      t.sql`delete from payment_intent_transitions where payment_intent_id = ${intent.id}`,
      "TA001",
    );
    await expectSqlState(
      t.sql`update payment_intent_transitions set reason = 'x' where payment_intent_id = ${intent.id}`,
      "TA001",
    );
  });

  test("TP003: a finished attempt can't change status", async () => {
    const { intent } = await create();
    const { attempt } = await confirm(intent.id, SIMULATED_ALIASES.declines);
    await runRail();
    await expectSqlState(
      t.sql`update payment_attempts set status = 'succeeded' where id = ${must(attempt).id}`,
      "TP003",
    );
  });
});
