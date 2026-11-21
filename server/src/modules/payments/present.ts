import { toPublicId } from "../../lib/ids";
import type { PaymentAttempt, PaymentIntent } from "./service";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Public API representation. Also used as the event `data.object` snapshot. */
export function presentPaymentIntent(
  intent: PaymentIntent,
  attempt: PaymentAttempt | null,
) {
  return {
    id: toPublicId("pi", intent.id),
    object: "payment_intent" as const,
    livemode: intent.livemode,
    status: intent.status,
    amount: Number(intent.amount),
    currency: intent.currency,
    fee: intent.fee === null ? null : Number(intent.fee),
    description: intent.description,
    merchant_reference: intent.merchantReference,
    metadata: intent.metadata,
    payer: attempt ? { alias: attempt.payerAlias } : null,
    latest_attempt: attempt
      ? {
          id: toPublicId("pa", attempt.id),
          status: attempt.status,
          rail: attempt.rail,
          rail_reference: attempt.railReference,
          failure_code: attempt.failureCode,
          failure_message: attempt.failureMessage,
          created_at: iso(attempt.createdAt),
        }
      : null,
    last_payment_error: intent.lastPaymentError,
    expires_at: iso(intent.expiresAt),
    succeeded_at: iso(intent.succeededAt),
    canceled_at: iso(intent.canceledAt),
    expired_at: iso(intent.expiredAt),
    created_at: iso(intent.createdAt),
  };
}

export type PublicPaymentIntent = ReturnType<typeof presentPaymentIntent>;
