import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { must } from "../../../test/assert";
import { createTestDb } from "../../../test/db";
import { createTestMerchant } from "../../../test/fixtures";
import { pgErrorCode } from "../../db/client";
import { DISPATCH_EVENT, ensureEventPartitions, pgEventBus } from ".";

let t: Awaited<ReturnType<typeof createTestDb>>;
let merchantId: string;

beforeAll(async () => {
  t = await createTestDb();
  merchantId = (await createTestMerchant(t.db)).id;
});

afterAll(async () => {
  await t.drop();
});

const input = () => ({
  type: "payment_intent.created" as const,
  merchantId,
  livemode: false,
  object: { id: "pi_test", object: "payment_intent" },
});

async function expectSqlState(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (err) {
    expect(pgErrorCode(err)).toBe(code);
    return;
  }
  throw new Error(`expected SQLSTATE ${code}, but the operation succeeded`);
}

describe("pgEventBus", () => {
  test("publish writes the event and its dispatch job together", async () => {
    const event = await t.db.transaction((tx) =>
      pgEventBus.publish(tx, input()),
    );
    expect(event.data).toEqual({
      object: { id: "pi_test", object: "payment_intent" },
    });
    const jobs = await t.db.query.jobs.findMany({
      where: (j, { eq }) => eq(j.dedupeKey, `${DISPATCH_EVENT}:${event.id}`),
    });
    expect(jobs).toHaveLength(1);
    expect(must(jobs[0]).payload).toEqual({ eventId: event.id });
  });

  test("a rolled-back transaction leaves neither event nor job", async () => {
    let id = "";
    await t.db
      .transaction(async (tx) => {
        id = (await pgEventBus.publish(tx, input())).id;
        tx.rollback();
      })
      .catch(() => {});
    const [row] =
      await t.sql`select (select count(*) from events where id = ${id})::int as events,
                         (select count(*) from jobs where payload->>'eventId' = ${id})::int as jobs`;
    expect(row).toEqual({ events: 0, jobs: 0 });
  });

  test("events land in the current month's partition, not the default", async () => {
    const event = await t.db.transaction((tx) =>
      pgEventBus.publish(tx, input()),
    );
    const [row] =
      await t.sql`select tableoid::regclass::text as part from events where id = ${event.id}`;
    expect(row?.part).toMatch(/^events_y\d{4}m\d{2}$/);
  });

  test("events are append-only", async () => {
    const event = await t.db.transaction((tx) =>
      pgEventBus.publish(tx, input()),
    );
    await expectSqlState(
      t.sql`update events set type = 'x' where id = ${event.id}`,
      "TA001",
    );
    await expectSqlState(
      t.sql`delete from events where id = ${event.id}`,
      "TA001",
    );
    await expectSqlState(t.sql`truncate events`, "TA001");
  });

  test("ensureEventPartitions is idempotent and creates months ahead", async () => {
    await ensureEventPartitions(t.db, 4);
    await ensureEventPartitions(t.db, 4);
    const [row] = await t.sql`
      select count(*)::int as n from pg_inherits
      where inhparent = 'events'::regclass
        and inhrelid::regclass::text like 'events_y%'`;
    expect(row?.n).toBeGreaterThanOrEqual(5);
  });
});
