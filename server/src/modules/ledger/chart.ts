import type { AccountSpec } from "./accounts";

// Chart of accounts for the direct-to-merchant flow. Tahseel never holds
// merchant funds, so payment volume is tracked in memo accounts and only
// fees touch Tahseel's own books. See docs/adr/0003-ledger-design.md.

export const chart = {
  /** Memo: funds a rail moved from payers to merchants, as confirmed by that rail. */
  railInflow: (rail: string): AccountSpec => ({
    code: `rail_inflow:${rail}`,
    type: "memo",
  }),
  /** Memo: funds a merchant collected through Tahseel (received directly in their account). */
  merchantCollected: (merchantId: string): AccountSpec => ({
    code: `merchant_collected:${merchantId}`,
    type: "memo",
    merchantId,
  }),
  /** Asset: fees the merchant owes Tahseel, billed separately. */
  feesReceivable: (merchantId: string): AccountSpec => ({
    code: `fees_receivable:${merchantId}`,
    type: "asset",
    merchantId,
  }),
  /** Revenue: Tahseel's fee income. */
  feeRevenue: (): AccountSpec => ({ code: "fee_revenue", type: "revenue" }),
} as const;
