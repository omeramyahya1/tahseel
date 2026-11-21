import type { DbOrTx } from "../../db/client";
import { events } from "../../db/schema";
import { enqueue } from "../../jobs";
import { newId } from "../../lib/ids";

export type EventRow = typeof events.$inferSelect;

export type EventType =
  | "payment_intent.created"
  | "payment_intent.processing"
  | "payment_intent.succeeded"
  | "payment_intent.payment_failed"
  | "payment_intent.canceled"
  | "payment_intent.expired";

export type PublishInput = {
  type: EventType;
  merchantId: string;
  livemode: boolean;
  /** Snapshot of the public API object at the time of the event. */
  object: Record<string, unknown>;
};

export const EVENTS_QUEUE = "events";
export const DISPATCH_EVENT = "dispatch_event";

export interface EventBus {
  /**
   * Records an event in the caller's transaction and enqueues its dispatch
   * (outbox pattern). Never publish outside the transaction that made the
   * change the event describes.
   */
  publish(tx: DbOrTx, input: PublishInput): Promise<EventRow>;
}

/** EventBus backed by the Postgres event log and job queue. */
export const pgEventBus: EventBus = {
  async publish(tx, input) {
    const [row] = await tx
      .insert(events)
      .values({
        id: newId(),
        type: input.type,
        merchantId: input.merchantId,
        livemode: input.livemode,
        data: { object: input.object },
      })
      .returning();
    if (!row) throw new Error("failed to insert event");
    await enqueue(tx, {
      queue: EVENTS_QUEUE,
      kind: DISPATCH_EVENT,
      payload: { eventId: row.id },
      dedupeKey: `${DISPATCH_EVENT}:${row.id}`,
    });
    return row;
  },
};
