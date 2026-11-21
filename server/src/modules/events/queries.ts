import { and, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { events } from "../../db/schema";
import { toPublicId } from "../../lib/ids";
import type { EventRow } from "./bus";

type Scope = { merchantId: string; livemode: boolean };

/** Public API representation; also the webhook request body. */
export function presentEvent(event: EventRow) {
  return {
    id: toPublicId("evt", event.id),
    object: "event" as const,
    type: event.type,
    livemode: event.livemode,
    created_at: event.createdAt.toISOString(),
    data: event.data,
  };
}

export type PublicEvent = ReturnType<typeof presentEvent>;

export async function getEventById(
  db: DbOrTx,
  id: string,
): Promise<EventRow | null> {
  const [event] = await db.select().from(events).where(eq(events.id, id));
  return event ?? null;
}

export async function getEvent(
  db: DbOrTx,
  scope: Scope,
  id: string,
): Promise<EventRow | null> {
  const [event] = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.id, id),
        eq(events.merchantId, scope.merchantId),
        eq(events.livemode, scope.livemode),
      ),
    );
  return event ?? null;
}

export async function listEvents(
  db: DbOrTx,
  scope: Scope,
  options: { limit: number; startingAfter?: string; type?: string },
): Promise<{ data: EventRow[]; hasMore: boolean } | null> {
  let cursor: EventRow | null = null;
  if (options.startingAfter) {
    cursor = await getEvent(db, scope, options.startingAfter);
    if (!cursor) return null;
  }
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.merchantId, scope.merchantId),
        eq(events.livemode, scope.livemode),
        options.type ? eq(events.type, options.type) : undefined,
        // Compare against the cursor row inside SQL: created_at has
        // microsecond precision, which a JS Date would truncate.
        cursor
          ? sql`(${events.createdAt}, ${events.id}) < (SELECT created_at, id FROM events WHERE id = ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(options.limit + 1);
  return {
    data: rows.slice(0, options.limit),
    hasMore: rows.length > options.limit,
  };
}
