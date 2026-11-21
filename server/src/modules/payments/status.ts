import type { paymentAttempts, paymentIntents } from "../../db/schema";

export type PaymentIntentStatus =
  (typeof paymentIntents.$inferSelect)["status"];
export type PaymentAttemptStatus =
  (typeof paymentAttempts.$inferSelect)["status"];

// Mirrored by triggers in migrations/0006_payments_invariants.sql.
export const INTENT_TRANSITIONS: Record<
  PaymentIntentStatus,
  readonly PaymentIntentStatus[]
> = {
  requires_confirmation: ["processing", "canceled", "expired"],
  // Back to requires_confirmation when the payer declines (retry allowed).
  // Expired only on the rail's word: never by our clock while processing.
  processing: ["succeeded", "requires_confirmation", "expired"],
  succeeded: [],
  canceled: [],
  expired: [],
};

export const ATTEMPT_TRANSITIONS: Record<
  PaymentAttemptStatus,
  readonly PaymentAttemptStatus[]
> = {
  pending: ["sent", "succeeded", "declined", "expired"],
  sent: ["succeeded", "declined", "expired"],
  succeeded: [],
  declined: [],
  expired: [],
};

export function canTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): boolean {
  return INTENT_TRANSITIONS[from].includes(to);
}

export const isFinalAttempt = (s: PaymentAttemptStatus) =>
  ATTEMPT_TRANSITIONS[s].length === 0;
