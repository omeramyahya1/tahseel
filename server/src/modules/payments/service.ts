import { and, desc, eq, lt, lte } from "drizzle-orm";
import {
  type RailRegistry,
  RailRejectedError,
  type RailStatus,
  REQUEST_TO_PAY_JOB,
  railQueue,
} from "../../connectors";
import { type Db, type DbOrTx, type Tx, withTx } from "../../db/client";
import {
  paymentAttempts,
  paymentIntents,
  paymentIntentTransitions,
} from "../../db/schema";
import { enqueue } from "../../jobs";
import { newId } from "../../lib/ids";
import type { EventBus, EventType } from "../events";
import { chart, postJournal } from "../ledger";
import { computeFee, getMerchant, pricingOf } from "../merchants";
import { PaymentError } from "./errors";
import { presentPaymentIntent } from "./present";
import {
  canTransition,
  isFinalAttempt,
  type PaymentIntentStatus,
} from "./status";

export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type PaymentIntentWithAttempt = {
  intent: PaymentIntent;
  attempt: PaymentAttempt | null;
};

export type PaymentsDeps = { bus: EventBus; rails: RailRegistry };

export type Scope = { merchantId: string; livemode: boolean };

export const DEFAULT_EXPIRY_MS = 15 * 60 * 1000;
export const MIN_EXPIRY_MS = 60 * 1000;
export const MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function lockIntent(tx: Tx, scope: Scope, id: string) {
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.id, id),
        eq(paymentIntents.merchantId, scope.merchantId),
        eq(paymentIntents.livemode, scope.livemode),
      ),
    )
    .for("update");
  if (!intent) {
    throw new PaymentError(
      "payment_intent_not_found",
      "No such payment intent.",
    );
  }
  return intent;
}

async function loadAttempt(db: DbOrTx, id: string | null) {
  if (!id) return null;
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, id));
  return attempt ?? null;
}

async function transition(
  tx: Tx,
  intent: PaymentIntent,
  to: PaymentIntentStatus,
  patch: Partial<PaymentIntent>,
  meta: { attemptId?: string; reason?: string } = {},
): Promise<PaymentIntent> {
  if (!canTransition(intent.status, to)) {
    throw new PaymentError(
      "payment_intent_unexpected_state",
      `This payment intent is ${intent.status} and can't move to ${to}.`,
    );
  }
  const [updated] = await tx
    .update(paymentIntents)
    .set({ ...patch, status: to })
    .where(eq(paymentIntents.id, intent.id))
    .returning();
  if (!updated) throw new Error(`payment intent ${intent.id} vanished`);
  await tx.insert(paymentIntentTransitions).values({
    id: newId(),
    paymentIntentId: intent.id,
    fromStatus: intent.status,
    toStatus: to,
    attemptId: meta.attemptId ?? null,
    reason: meta.reason ?? null,
  });
  return updated;
}

async function publish(
  tx: Tx,
  deps: PaymentsDeps,
  type: EventType,
  intent: PaymentIntent,
  attempt: PaymentAttempt | null,
) {
  await deps.bus.publish(tx, {
    type,
    merchantId: intent.merchantId,
    livemode: intent.livemode,
    object: presentPaymentIntent(intent, attempt),
  });
}

// ---------------------------------------------------------------------------
// Merchant-facing operations
// ---------------------------------------------------------------------------

export type CreatePaymentIntentInput = Scope & {
  amount: bigint;
  description?: string | null;
  merchantReference?: string | null;
  metadata?: Record<string, string>;
  expiresAt?: Date;
};

export async function createPaymentIntent(
  tx: Tx,
  deps: PaymentsDeps,
  input: CreatePaymentIntentInput,
): Promise<PaymentIntentWithAttempt> {
  if (input.amount <= 0n) {
    throw new RangeError("amount must be positive");
  }
  const now = Date.now();
  const expiresAt = input.expiresAt ?? new Date(now + DEFAULT_EXPIRY_MS);

  const [intent] = await tx
    .insert(paymentIntents)
    .values({
      id: newId(),
      merchantId: input.merchantId,
      livemode: input.livemode,
      amount: input.amount,
      currency: "SDG",
      status: "requires_confirmation",
      description: input.description ?? null,
      merchantReference: input.merchantReference ?? null,
      metadata: input.metadata ?? {},
      expiresAt,
    })
    .returning();
  if (!intent) throw new Error("failed to create payment intent");

  await tx.insert(paymentIntentTransitions).values({
    id: newId(),
    paymentIntentId: intent.id,
    fromStatus: null,
    toStatus: "requires_confirmation",
  });
  await publish(tx, deps, "payment_intent.created", intent, null);
  return { intent, attempt: null };
}

export async function getPaymentIntent(
  db: DbOrTx,
  scope: Scope,
  id: string,
): Promise<PaymentIntentWithAttempt | null> {
  const [row] = await db
    .select({ intent: paymentIntents, attempt: paymentAttempts })
    .from(paymentIntents)
    .leftJoin(
      paymentAttempts,
      eq(paymentAttempts.id, paymentIntents.latestAttemptId),
    )
    .where(
      and(
        eq(paymentIntents.id, id),
        eq(paymentIntents.merchantId, scope.merchantId),
        eq(paymentIntents.livemode, scope.livemode),
      ),
    );
  return row ?? null;
}

export async function listPaymentIntents(
  db: DbOrTx,
  scope: Scope,
  options: { limit: number; startingAfter?: string },
): Promise<{ data: PaymentIntentWithAttempt[]; hasMore: boolean }> {
  const rows = await db
    .select({ intent: paymentIntents, attempt: paymentAttempts })
    .from(paymentIntents)
    .leftJoin(
      paymentAttempts,
      eq(paymentAttempts.id, paymentIntents.latestAttemptId),
    )
    .where(
      and(
        eq(paymentIntents.merchantId, scope.merchantId),
        eq(paymentIntents.livemode, scope.livemode),
        options.startingAfter
          ? lt(paymentIntents.id, options.startingAfter)
          : undefined,
      ),
    )
    // ULIDs sort by creation time: newest first.
    .orderBy(desc(paymentIntents.id))
    .limit(options.limit + 1);
  return {
    data: rows.slice(0, options.limit),
    hasMore: rows.length > options.limit,
  };
}

/**
 * Starts a payment: creates an attempt and hands a request-to-pay to the
 * rail's queue (outbox). The intent is `processing` until the rail reports.
 */
export async function confirmPaymentIntent(
  tx: Tx,
  deps: PaymentsDeps,
  input: Scope & { id: string; payerAlias: string },
): Promise<PaymentIntentWithAttempt> {
  const intent = await lockIntent(tx, input, input.id);
  if (intent.status !== "requires_confirmation") {
    throw new PaymentError(
      "payment_intent_unexpected_state",
      `This payment intent is ${intent.status}; only requires_confirmation intents can be confirmed.`,
    );
  }
  if (intent.expiresAt.getTime() <= Date.now()) {
    throw new PaymentError(
      "payment_intent_expired",
      "This payment intent has expired.",
    );
  }
  const rail = deps.rails.forMode(intent.livemode);
  if (!rail) {
    throw new PaymentError(
      "rail_unavailable",
      intent.livemode
        ? "Live payments aren't available yet: no live payment rail is connected."
        : "No payment rail is configured for test mode.",
    );
  }

  const [attempt] = await tx
    .insert(paymentAttempts)
    .values({
      id: newId(),
      paymentIntentId: intent.id,
      livemode: intent.livemode,
      rail: rail.name,
      payerAlias: input.payerAlias,
    })
    .returning();
  if (!attempt) throw new Error("failed to create payment attempt");

  const updated = await transition(
    tx,
    intent,
    "processing",
    { latestAttemptId: attempt.id, lastPaymentError: null },
    { attemptId: attempt.id, reason: "confirmed" },
  );
  await enqueue(tx, {
    queue: railQueue(rail.name),
    kind: REQUEST_TO_PAY_JOB,
    payload: { attemptId: attempt.id },
    dedupeKey: `${REQUEST_TO_PAY_JOB}:${attempt.id}`,
  });
  await publish(tx, deps, "payment_intent.processing", updated, attempt);
  return { intent: updated, attempt };
}

export async function cancelPaymentIntent(
  tx: Tx,
  deps: PaymentsDeps,
  input: Scope & { id: string },
): Promise<PaymentIntentWithAttempt> {
  const intent = await lockIntent(tx, input, input.id);
  if (intent.status !== "requires_confirmation") {
    throw new PaymentError(
      "payment_intent_unexpected_state",
      `This payment intent is ${intent.status}; only requires_confirmation intents can be canceled.`,
    );
  }
  const updated = await transition(
    tx,
    intent,
    "canceled",
    { canceledAt: new Date() },
    { reason: "canceled_by_merchant" },
  );
  const attempt = await loadAttempt(tx, updated.latestAttemptId);
  await publish(tx, deps, "payment_intent.canceled", updated, attempt);
  return { intent: updated, attempt };
}

/**
 * Expires unconfirmed intents past expires_at. `processing` intents are
 * never expired here: only the rail can say a request-to-pay expired,
 * otherwise we could expire an intent the payer actually paid.
 */
export async function expireDuePaymentIntents(
  db: Db,
  deps: PaymentsDeps,
  limit = 100,
): Promise<number> {
  return withTx(db, async (tx) => {
    const due = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.status, "requires_confirmation"),
          lte(paymentIntents.expiresAt, new Date()),
        ),
      )
      .orderBy(paymentIntents.expiresAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    for (const intent of due) {
      const updated = await transition(
        tx,
        intent,
        "expired",
        { expiredAt: new Date() },
        { reason: "expires_at_reached" },
      );
      const attempt = await loadAttempt(tx, updated.latestAttemptId);
      await publish(tx, deps, "payment_intent.expired", updated, attempt);
    }
    return due.length;
  });
}

// ---------------------------------------------------------------------------
// Rail-facing operations (run by the worker)
// ---------------------------------------------------------------------------

/** Job handler body for `request_to_pay`. Safe to retry. */
export async function sendRequestToPay(
  db: Db,
  deps: PaymentsDeps,
  attemptId: string,
): Promise<void> {
  const attempt = await loadAttempt(db, attemptId);
  if (!attempt) throw new Error(`payment attempt ${attemptId} not found`);
  if (attempt.status !== "pending") return; // already sent or finished

  const [intent] = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, attempt.paymentIntentId));
  if (!intent) throw new Error(`payment intent for ${attemptId} not found`);
  const merchant = await getMerchant(db, intent.merchantId);
  if (!merchant) throw new Error(`merchant ${intent.merchantId} not found`);
  const rail = deps.rails.byName(attempt.rail);
  if (!rail) throw new Error(`rail ${attempt.rail} is not configured`);

  try {
    const { railReference } = await rail.requestToPay({
      attemptId: attempt.id,
      livemode: attempt.livemode,
      amount: intent.amount,
      currency: intent.currency,
      creditor: {
        name: merchant.name,
        bankCode: merchant.creditorBankCode,
        account: merchant.creditorAccount,
      },
      debtorAlias: attempt.payerAlias,
      expiresAt: intent.expiresAt,
      remittanceInfo: intent.description,
    });
    await db
      .update(paymentAttempts)
      .set({ status: "sent", railReference })
      .where(
        and(
          eq(paymentAttempts.id, attempt.id),
          eq(paymentAttempts.status, "pending"),
        ),
      );
  } catch (err) {
    if (!(err instanceof RailRejectedError)) throw err; // retried by the queue
    await withTx(db, (tx) =>
      applyRailStatus(tx, deps, {
        rail: attempt.rail,
        attemptId: attempt.id,
        railReference: null,
        outcome: "declined",
        reasonCode: err.code,
        reasonMessage: err.message,
      }),
    );
  }
}

export type ApplyRailStatusResult = "applied" | "duplicate" | "unknown_attempt";

/**
 * Applies a rail status report. Idempotent: a repeated report for a finished
 * attempt is a no-op. On success, the status change, fee, ledger journal and
 * event all commit in this one transaction.
 */
export async function applyRailStatus(
  tx: Tx,
  deps: PaymentsDeps,
  status: RailStatus,
): Promise<ApplyRailStatusResult> {
  const [attempt] = await tx
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, status.attemptId),
        eq(paymentAttempts.rail, status.rail),
      ),
    )
    .for("update");
  if (!attempt) return "unknown_attempt";
  if (isFinalAttempt(attempt.status)) return "duplicate";

  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, attempt.paymentIntentId))
    .for("update");
  if (!intent) throw new Error(`payment intent for ${attempt.id} not found`);
  if (intent.status !== "processing" || intent.latestAttemptId !== attempt.id) {
    // Can't happen through our own transitions. Fail loudly so the job goes
    // dead and someone looks: a rail may have moved money we can't attribute.
    throw new Error(
      `rail status for attempt ${attempt.id} but intent ${intent.id} is ${intent.status} with latest attempt ${intent.latestAttemptId}`,
    );
  }

  const [updatedAttempt] = await tx
    .update(paymentAttempts)
    .set({
      status: status.outcome,
      railReference: attempt.railReference ?? status.railReference,
      failureCode: status.reasonCode ?? null,
      failureMessage: status.reasonMessage ?? null,
    })
    .where(eq(paymentAttempts.id, attempt.id))
    .returning();
  if (!updatedAttempt)
    throw new Error(`payment attempt ${attempt.id} vanished`);

  const error = {
    code: status.reasonCode ?? status.outcome,
    message: status.reasonMessage ?? `The payment was ${status.outcome}.`,
  };

  if (status.outcome === "succeeded") {
    const merchant = await getMerchant(tx, intent.merchantId);
    if (!merchant) throw new Error(`merchant ${intent.merchantId} not found`);
    const fee = computeFee(intent.amount, pricingOf(merchant));

    const updated = await transition(
      tx,
      intent,
      "succeeded",
      { fee, succeededAt: new Date() },
      { attemptId: attempt.id, reason: "rail_confirmed" },
    );

    const postings = [
      {
        account: chart.merchantCollected(intent.merchantId),
        amount: intent.amount,
      },
      { account: chart.railInflow(attempt.rail), amount: -intent.amount },
    ];
    if (fee > 0n) {
      postings.push(
        { account: chart.feesReceivable(intent.merchantId), amount: fee },
        { account: chart.feeRevenue(), amount: -fee },
      );
    }
    await postJournal(tx, {
      kind: "payment_succeeded",
      livemode: intent.livemode,
      source: { type: "payment_intent", id: intent.id },
      description: `Payment ${intent.id} confirmed by ${attempt.rail}`,
      postings,
    });
    await publish(
      tx,
      deps,
      "payment_intent.succeeded",
      updated,
      updatedAttempt,
    );
  } else if (status.outcome === "declined") {
    const updated = await transition(
      tx,
      intent,
      "requires_confirmation",
      { lastPaymentError: error },
      { attemptId: attempt.id, reason: error.code },
    );
    await publish(
      tx,
      deps,
      "payment_intent.payment_failed",
      updated,
      updatedAttempt,
    );
  } else {
    const updated = await transition(
      tx,
      intent,
      "expired",
      { expiredAt: new Date(), lastPaymentError: error },
      { attemptId: attempt.id, reason: error.code },
    );
    await publish(tx, deps, "payment_intent.expired", updated, updatedAttempt);
  }
  return "applied";
}
