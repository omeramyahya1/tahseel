import type { Db } from "../db/client";
import { claim, complete, fail, type Job } from "./queue";

export type JobHandler = (job: Job) => Promise<void>;

/** Handlers keyed by job kind. Handlers must be idempotent (at-least-once). */
export type HandlerMap = Record<string, JobHandler>;

/** Thrown by a handler to retry after a specific delay instead of the default backoff. */
export class RetryLater extends Error {
  constructor(
    readonly seconds: number,
    message = "retry later",
  ) {
    super(message);
    this.name = "RetryLater";
  }
}

async function runJob(db: Db, handlers: HandlerMap, job: Job) {
  const handler = handlers[job.kind];
  try {
    if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
    await handler(job);
    await complete(db, job.id);
  } catch (err) {
    await fail(
      db,
      job,
      err,
      err instanceof RetryLater ? err.seconds : undefined,
    );
  }
}

/** Processes due jobs on a queue until none are left. Returns how many ran. */
export async function drain(
  db: Db,
  queue: string,
  handlers: HandlerMap,
  batch = 10,
): Promise<number> {
  let total = 0;
  for (;;) {
    const claimed = await claim(db, queue, batch);
    if (claimed.length === 0) return total;
    await Promise.all(claimed.map((job) => runJob(db, handlers, job)));
    total += claimed.length;
  }
}

export type QueueConfig = {
  queue: string;
  handlers: HandlerMap;
  concurrency: number;
  pollMs?: number;
};

/**
 * Polls one queue with its own concurrency limit, so a slow or failing queue
 * (e.g. one rail) never starves the others.
 */
export function startQueue(db: Db, config: QueueConfig) {
  let stopped = false;
  let inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: (() => void) | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const free = config.concurrency - inFlight;
      if (free > 0) {
        const claimed = await claim(db, config.queue, free);
        for (const job of claimed) {
          inFlight++;
          runJob(db, config.handlers, job)
            .catch((err) => console.error(`[${config.queue}] job error`, err))
            .finally(() => {
              inFlight--;
              if (stopped && inFlight === 0) idle?.();
            });
        }
        if (claimed.length === free) return schedule(0);
      }
    } catch (err) {
      console.error(`[${config.queue}] poll error`, err);
    }
    schedule(config.pollMs ?? 500);
  };

  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(tick, ms);
  };

  schedule(0);

  return {
    /** Stops polling and waits for in-flight jobs to finish. */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (inFlight > 0) await new Promise<void>((r) => (idle = r));
    },
  };
}
