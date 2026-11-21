export type LedgerErrorCode =
  | "too_few_postings"
  | "unbalanced"
  | "invalid_amount"
  | "account_type_mismatch";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}
