import { z } from "zod";

// IDs are ULIDs stored as uuid: not RFC 4122, so use z.guid(), never z.uuid().
import { RAIL_STATUS_JOB, REQUEST_TO_PAY_JOB } from "../../connectors";
import { type Db, withTx } from "../../db/client";
import type { HandlerMap } from "../../jobs";
import {
  applyRailStatus,
  type PaymentsDeps,
  sendRequestToPay,
} from "./service";

const RequestToPayPayload = z.object({ attemptId: z.guid() });

const RailStatusPayload = z.object({
  rail: z.string(),
  attemptId: z.guid(),
  railReference: z.string().nullable(),
  outcome: z.enum(["succeeded", "declined", "expired"]),
  reasonCode: z.string().optional(),
  reasonMessage: z.string().optional(),
});

/** Handlers for each rail queue (`rail:<name>`). */
export function railJobHandlers(db: Db, deps: PaymentsDeps): HandlerMap {
  return {
    [REQUEST_TO_PAY_JOB]: async (job) => {
      const { attemptId } = RequestToPayPayload.parse(job.payload);
      await sendRequestToPay(db, deps, attemptId);
    },
    [RAIL_STATUS_JOB]: async (job) => {
      const payload = RailStatusPayload.parse(job.payload);
      const { reasonCode, reasonMessage, ...rest } = payload;
      await withTx(db, (tx) =>
        applyRailStatus(tx, deps, {
          ...rest,
          ...(reasonCode !== undefined ? { reasonCode } : {}),
          ...(reasonMessage !== undefined ? { reasonMessage } : {}),
        }),
      );
    },
  };
}
