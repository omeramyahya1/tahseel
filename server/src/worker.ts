// Background worker: outbox relay (event dispatch), rail queues and
// periodic maintenance. Run one or more; every job and task is safe to
// run concurrently.

import { railQueue, SIMULATED_RAIL } from "./connectors";
import { loadEnv } from "./env";
import { pruneIdempotencyKeys } from "./http/idempotency";
import { pruneDoneJobs, startQueue } from "./jobs";
import {
  EVENTS_QUEUE,
  ensureEventPartitions,
  eventJobHandlers,
} from "./modules/events";
import { expireDuePaymentIntents, railJobHandlers } from "./modules/payments";
import { createRuntime } from "./runtime";

const env = loadEnv();
const { db, sql, payments } = createRuntime(env);

const queues = [
  startQueue(db, {
    queue: EVENTS_QUEUE,
    concurrency: 10,
    handlers: eventJobHandlers(),
  }),
  // One queue per rail: a slow or failing rail never blocks another.
  startQueue(db, {
    queue: railQueue(SIMULATED_RAIL),
    concurrency: 5,
    handlers: railJobHandlers(db, payments),
  }),
];

function every(ms: number, name: string, task: () => Promise<unknown>) {
  const run = () =>
    task().catch((err) => console.error(`[maintenance] ${name} failed`, err));
  run();
  return setInterval(run, ms);
}

const timers = [
  every(5_000, "expire payment intents", () =>
    expireDuePaymentIntents(db, payments),
  ),
  every(60 * 60_000, "ensure event partitions", () =>
    ensureEventPartitions(db, 2),
  ),
  every(60 * 60_000, "prune jobs and idempotency keys", async () => {
    await pruneDoneJobs(db);
    await pruneIdempotencyKeys(db);
  }),
];

console.log("worker started");

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("worker stopping");
  for (const t of timers) clearInterval(t);
  await Promise.all(queues.map((q) => q.stop()));
  await sql.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
