// Background worker: outbox relay, webhooks, notifications, reconciliation, rail polling.
// No jobs are registered yet.

console.log("worker started");

const shutdown = () => {
  console.log("worker stopping");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(() => {}, 1 << 30);
