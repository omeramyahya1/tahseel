import type { Db } from "../db/client";
import { claim, complete, fail, type Job, release } from "./queue";

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
    await complete(db, job);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | null = null;
  const inFlight = new Set<Promise<void>>();

  const poll = async () => {
    const free = config.concurrency - inFlight.size;
    if (free <= 0) return false;
    const claimed = await claim(db, config.queue, free);
    if (stopped) {
      // stop() was called while claim() was in flight: hand the jobs back
      // rather than starting work after shutdown.
      await Promise.all(claimed.map((job) => release(db, job)));
      return false;
    }
    for (const job of claimed) {
      const run = runJob(db, config.handlers, job)
        .catch((err) => console.error(`[${config.queue}] job error`, err))
        .finally(() => inFlight.delete(run));
      inFlight.add(run);
    }
    return claimed.length === free;
  };

  const tick = () => {
    if (stopped) return;
    polling = poll()
      .catch((err) => {
        console.error(`[${config.queue}] poll error`, err);
        return false;
      })
      .then((busy) => schedule(busy ? 0 : (config.pollMs ?? 500)))
      .finally(() => {
        polling = null;
      });
  };

  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(tick, ms);
  };

  schedule(0);

  return {
    /**
     * Stops polling, waits for an in-progress poll (whose claimed jobs are
     * released), then waits for in-flight jobs to finish.
     */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (polling) await polling;
      await Promise.allSettled([...inFlight]);
    },
  };
}
