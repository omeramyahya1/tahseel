export type PaymentErrorCode =
  | "payment_intent_not_found"
  | "payment_intent_unexpected_state"
  | "payment_intent_expired"
  | "rail_unavailable";

export class PaymentError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}
