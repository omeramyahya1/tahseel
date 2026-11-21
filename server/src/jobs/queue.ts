import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { jobs } from "../db/schema";
import { newId } from "../lib/ids";

export type Job = typeof jobs.$inferSelect;

export type EnqueueInput = {
  queue: string;
  kind: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  dedupeKey?: string;
};

/**
 * Enqueues a job in the caller's transaction (the outbox pattern). The job is
 * only visible to workers once that transaction commits.
 */
export async function enqueue(tx: DbOrTx, input: EnqueueInput): Promise<void> {
  await tx
    .insert(jobs)
    .values({
      id: newId(),
      queue: input.queue,
      kind: input.kind,
      payload: input.payload,
      runAt: input.runAt ?? sql`now()`,
      maxAttempts: input.maxAttempts ?? 10,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey });
}

/**
 * Claims up to `limit` due jobs from a queue. A claimed job is locked for
 * `lockSeconds`; if the worker dies, it becomes claimable again afterwards.
 */
export async function claim(
  db: DbOrTx,
  queue: string,
  limit: number,
  lockSeconds = 60,
): Promise<Job[]> {
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.queue, queue),
        or(
          and(eq(jobs.status, "pending"), lte(jobs.runAt, sql`now()`)),
          and(eq(jobs.status, "running"), lt(jobs.lockedUntil, sql`now()`)),
        ),
      ),
    )
    .orderBy(jobs.runAt)
    .limit(limit)
    .for("update", { skipLocked: true });

  return db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      lockedUntil: sql`now() + make_interval(secs => ${lockSeconds})`,
      updatedAt: sql`now()`,
    })
    .where(inArray(jobs.id, due))
    .returning();
}

export async function complete(db: DbOrTx, jobId: string): Promise<void> {
  await db.execute(sql`
    UPDATE jobs SET status = 'done', locked_until = NULL, updated_at = now()
    WHERE id = ${jobId}`);
}

/** Exponential backoff: 2^attempts seconds, capped at 1 hour, with jitter. */
export function backoffSeconds(attempts: number): number {
  const base = Math.min(2 ** attempts, 3600);
  return base + Math.random() * base * 0.1;
}

export async function fail(
  db: DbOrTx,
  job: Job,
  error: unknown,
  retryInSeconds = backoffSeconds(job.attempts),
): Promise<void> {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const dead = job.attempts >= job.maxAttempts;
  await db.execute(sql`
    UPDATE jobs
    SET status = ${dead ? "dead" : "pending"},
        run_at = now() + make_interval(secs => ${retryInSeconds}),
        locked_until = NULL,
        last_error = ${message.slice(0, 2000)},
        updated_at = now()
    WHERE id = ${job.id}`);
}

/** Deletes finished jobs older than `days`. Dead jobs are kept for inspection. */
export async function pruneDoneJobs(db: DbOrTx, days = 7): Promise<number> {
  const rows = await db.execute(sql`
    DELETE FROM jobs
    WHERE status = 'done' AND updated_at < now() - make_interval(days => ${days})
    RETURNING id`);
  return rows.length;
}
