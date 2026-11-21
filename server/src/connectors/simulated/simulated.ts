import { createHash } from "node:crypto";
import type { DbOrTx } from "../../db/client";
import { enqueue } from "../../jobs";
import {
  RAIL_STATUS_JOB,
  type RailConnector,
  type RailOutcome,
  RailRejectedError,
  type RailStatus,
  railQueue,
} from "../types";

// Test-mode stand-in for a real rail (NIPS etc.). The payer's alias decides
// what happens, like Stripe's test card numbers. The outcome is reported
// asynchronously through the same `rail_status` job a real rail callback
// would produce.

export const SIMULATED_RAIL = "simulated";

export const SIMULATED_ALIASES = {
  succeeds: "+249900000001",
  declines: "+249900000002",
  noResponse: "+249900000003", // payer never approves: expires at expires_at
  unknownAlias: "+249900000004", // rail rejects the request-to-pay outright
} as const;

export function createSimulatedRail(deps: {
  db: DbOrTx;
  /** Delay before the simulated payer responds. */
  responseDelayMs?: number;
}): RailConnector {
  const delay = deps.responseDelayMs ?? 2_000;

  return {
    name: SIMULATED_RAIL,
    async requestToPay(req) {
      if (req.livemode) {
        throw new RailRejectedError(
          "livemode_not_supported",
          "The simulated rail only processes test-mode payments.",
        );
      }
      if (req.debtorAlias === SIMULATED_ALIASES.unknownAlias) {
        throw new RailRejectedError(
          "alias_not_found",
          "No account is registered for this alias.",
        );
      }

      // Deterministic per attempt, so a retried request is idempotent.
      const railReference = `sim_${createHash("sha256").update(req.attemptId).digest("hex").slice(0, 24)}`;

      let outcome: RailOutcome = "succeeded";
      let runAt = new Date(Date.now() + delay);
      const status: Partial<RailStatus> = {};
      if (req.debtorAlias === SIMULATED_ALIASES.declines) {
        outcome = "declined";
        status.reasonCode = "payer_declined";
        status.reasonMessage = "The payer declined the request.";
      } else if (req.debtorAlias === SIMULATED_ALIASES.noResponse) {
        outcome = "expired";
        status.reasonCode = "request_expired";
        status.reasonMessage = "The payer didn't respond before expiry.";
        runAt = req.expiresAt;
      }

      const payload: RailStatus = {
        rail: SIMULATED_RAIL,
        attemptId: req.attemptId,
        railReference,
        outcome,
        ...status,
      };
      await enqueue(deps.db, {
        queue: railQueue(SIMULATED_RAIL),
        kind: RAIL_STATUS_JOB,
        payload,
        runAt,
        dedupeKey: `simulated_status:${req.attemptId}`,
      });
      return { railReference };
    },
  };
}
