import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { must } from "../../test/assert";
import { createTestDb } from "../../test/db";
import { newId } from "../lib/ids";
import {
  claim,
  complete,
  drain,
  enqueue,
  fail,
  type Job,
  RetryLater,
  startQueue,
} from ".";

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.drop();
});

const q = () => `test:${newId()}`;

async function jobRows(queue: string) {
  return t.db.query.jobs.findMany({ where: (j, { eq }) => eq(j.queue, queue) });
}

describe("job queue", () => {
  test("stores the payload as a JSON object", async () => {
    const queue = q();
    await enqueue(t.db, { queue, kind: "k", payload: { a: 1, b: "x" } });
    const [row] =
      await t.sql`select jsonb_typeof(payload) as type, payload->>'b' as b from jobs where queue = ${queue}`;
    expect(row).toEqual({ type: "object", b: "x" });
  });

  test("jobs enqueued in a rolled-back transaction never run", async () => {
    const queue = q();
    await t.db
      .transaction(async (tx) => {
        await enqueue(tx, { queue, kind: "k", payload: {} });
        tx.rollback();
      })
      .catch(() => {});
    expect(await jobRows(queue)).toHaveLength(0);
  });

  test("dedupe key makes enqueue idempotent", async () => {
    const queue = q();
    const dedupeKey = newId();
    await enqueue(t.db, { queue, kind: "k", payload: {}, dedupeKey });
    await enqueue(t.db, { queue, kind: "k", payload: {}, dedupeKey });
    expect(await jobRows(queue)).toHaveLength(1);
  });

  test("future jobs aren't claimed until due", async () => {
    const queue = q();
    await enqueue(t.db, {
      queue,
      kind: "k",
      payload: {},
      runAt: new Date(Date.now() + 60_000),
    });
    expect(await claim(t.db, queue, 10)).toHaveLength(0);
  });

  test("concurrent claimers never get the same job (SKIP LOCKED)", async () => {
    const queue = q();
    for (let i = 0; i < 20; i++) {
      await enqueue(t.db, { queue, kind: "k", payload: { i } });
    }
    const batches = await Promise.all(
      Array.from({ length: 5 }, () => claim(t.db, queue, 10)),
    );
    const ids = batches.flat().map((j) => j.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  test("drain runs handlers and marks jobs done", async () => {
    const queue = q();
    const seen: unknown[] = [];
    await enqueue(t.db, { queue, kind: "k", payload: { n: 1 } });
    await enqueue(t.db, { queue, kind: "k", payload: { n: 2 } });
    const ran = await drain(t.db, queue, {
      k: async (job) => {
        seen.push(job.payload.n);
      },
    });
    expect(ran).toBe(2);
    expect(seen.sort()).toEqual([1, 2]);
    expect((await jobRows(queue)).map((j) => j.status)).toEqual([
      "done",
      "done",
    ]);
  });

  test("failures retry with backoff, then go dead after max attempts", async () => {
    const queue = q();
    await enqueue(t.db, { queue, kind: "k", payload: {}, maxAttempts: 2 });
    const boom = { k: async () => Promise.reject(new Error("boom")) };

    await drain(t.db, queue, boom);
    let [job] = await jobRows(queue);
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toBe("Error: boom");
    expect(must(job).runAt.getTime()).toBeGreaterThan(Date.now());

    await t.db.execute(
      sql`update jobs set run_at = now() where queue = ${queue}`,
    );
    await drain(t.db, queue, boom);
    [job] = await jobRows(queue);
    expect(job?.status).toBe("dead");
    expect(job?.attempts).toBe(2);
  });

  test("RetryLater sets the retry delay", async () => {
    const queue = q();
    await enqueue(t.db, { queue, kind: "k", payload: {} });
    await drain(t.db, queue, {
      k: async () => {
        throw new RetryLater(120);
      },
    });
    const [job] = await jobRows(queue);
    const delay = must(job).runAt.getTime() - Date.now();
    expect(delay).toBeGreaterThan(110_000);
    expect(delay).toBeLessThan(125_000);
  });

  test("unknown job kinds fail instead of being silently dropped", async () => {
    const queue = q();
    await enqueue(t.db, { queue, kind: "mystery", payload: {} });
    await drain(t.db, queue, {});
    const [job] = await jobRows(queue);
    expect(job?.status).toBe("pending");
    expect(job?.lastError).toContain('no handler for job kind "mystery"');
  });

  test("a job whose lock expired is claimable again", async () => {
    const queue = q();
    await enqueue(t.db, { queue, kind: "k", payload: {} });
    const [first] = await claim(t.db, queue, 1, 60);
    expect(await claim(t.db, queue, 1)).toHaveLength(0);
    await t.db.execute(
      sql`update jobs set locked_until = now() - interval '1 second' where id = ${must(first).id}`,
    );
    const [again] = await claim(t.db, queue, 1);
    expect(again?.id).toBe(must(first).id);
    expect(again?.attempts).toBe(2);
  });

  test("startQueue processes jobs and stops cleanly", async () => {
    const queue = q();
    const done: Job[] = [];
    const runner = startQueue(t.db, {
      queue,
      concurrency: 2,
      pollMs: 20,
      handlers: {
        k: async (job) => {
          done.push(job);
        },
      },
    });
    for (let i = 0; i < 5; i++) {
      await enqueue(t.db, { queue, kind: "k", payload: { i } });
    }
    const deadline = Date.now() + 3_000;
    while (done.length < 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await runner.stop();
    expect(done).toHaveLength(5);
  });

  test("a stale claim's ack updates nothing; the current claim's ack works", async () => {
    const queue = q();
    await enqueue(t.db, { queue, kind: "k", payload: {} });
    const first = must((await claim(t.db, queue, 1))[0]);
    await t.db.execute(
      sql`update jobs set locked_until = now() - interval '1 second' where id = ${first.id}`,
    );
    const second = must((await claim(t.db, queue, 1))[0]);
    expect(second.attempts).toBe(first.attempts + 1);

    // The first worker finishes late: its acks must not touch the job.
    expect(await complete(t.db, first)).toBe(false);
    expect(await fail(t.db, first, new Error("late"))).toBe(false);
    let [row] = await jobRows(queue);
    expect(row).toMatchObject({
      status: "running",
      attempts: 2,
      lastError: null,
    });

    expect(await complete(t.db, second)).toBe(true);
    [row] = await jobRows(queue);
    expect(row?.status).toBe("done");
    // Acks don't apply twice either.
    expect(await complete(t.db, second)).toBe(false);
  });

  test("stop() waits for an in-flight claim and releases what it claimed", async () => {
    const queue = q();
    await enqueue(t.db, { queue, kind: "k", payload: {} });
    let handled = 0;

    // Hold a table lock so the runner's claim() blocks mid-flight.
    const locker = await t.sql.reserve();
    await locker`begin`;
    await locker`lock table jobs in access exclusive mode`;

    const runner = startQueue(t.db, {
      queue,
      concurrency: 1,
      pollMs: 10,
      handlers: {
        k: async () => {
          handled++;
        },
      },
    });
    await new Promise((r) => setTimeout(r, 50)); // claim() is now blocked

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false); // still waiting for the claim

    await locker`rollback`;
    locker.release();
    await stopping;

    expect(handled).toBe(0);
    const [row] = await jobRows(queue);
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
  });
});
