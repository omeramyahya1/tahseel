import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";

/** Creates monthly event partitions through `monthsAhead` months from now. */
export async function ensureEventPartitions(
  db: DbOrTx,
  monthsAhead = 2,
): Promise<void> {
  await db.execute(sql`SELECT ensure_event_partitions(${monthsAhead})`);
}
