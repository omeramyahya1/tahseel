// Rail connector contract, shaped after ISO 20022 request-to-pay:
// requestToPay ~ pain.013 (creditor asks the debtor's bank to pay), and the
// rail's status report ~ pacs.002 / pain.014, delivered to Tahseel as a
// `rail_status` job (from a rail callback or, for the simulator, by itself).

export type RequestToPay = {
  /** Tahseel's end-to-end ID for this attempt (payment_attempts.id). */
  attemptId: string;
  livemode: boolean;
  /** Minor units. */
  amount: bigint;
  currency: string;
  creditor: { name: string; bankCode: string; account: string };
  /** Payer's alias in the rail's alias directory (phone number for now). */
  debtorAlias: string;
  /** The rail must not let the payer approve after this. */
  expiresAt: Date;
  /** Shown to the payer, e.g. the merchant's description. */
  remittanceInfo: string | null;
};

export type RailOutcome = "succeeded" | "declined" | "expired";

/** Status report from a rail, processed by the payments module. */
export type RailStatus = {
  rail: string;
  attemptId: string;
  /** Null when the rail refused the request before assigning a reference. */
  railReference: string | null;
  outcome: RailOutcome;
  /** For declined/expired: the rail's reason. */
  reasonCode?: string;
  reasonMessage?: string;
};

/** The rail refused the request permanently (e.g. unknown alias). Not retried. */
export class RailRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RailRejectedError";
  }
}

export interface RailConnector {
  readonly name: string;
  /**
   * Sends a request-to-pay. Must be idempotent per attemptId (it can be
   * retried). Throw RailRejectedError for permanent refusals; any other error
   * is retried with backoff.
   */
  requestToPay(req: RequestToPay): Promise<{ railReference: string }>;
}

export const RAIL_STATUS_JOB = "rail_status";
export const REQUEST_TO_PAY_JOB = "request_to_pay";
export const railQueue = (rail: string) => `rail:${rail}`;

export interface RailRegistry {
  /** The rail used to confirm payments in this mode, or null if none. */
  forMode(livemode: boolean): RailConnector | null;
  byName(name: string): RailConnector | null;
}

export function createRailRegistry(config: {
  test: RailConnector | null;
  live: RailConnector | null;
}): RailRegistry {
  const all = [config.test, config.live].filter(
    (r): r is RailConnector => r !== null,
  );
  return {
    forMode: (livemode) => (livemode ? config.live : config.test),
    byName: (name) => all.find((r) => r.name === name) ?? null,
  };
}
