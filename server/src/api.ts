import { Hono } from "hono";
import { createDb } from "./db/client";
import { loadEnv } from "./env";

const env = loadEnv();
const { sql } = createDb(env.DATABASE_URL);

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/health/db", async (c) => {
  await sql`select 1`;
  return c.json({ status: "ok" });
});

export default {
  port: env.API_PORT,
  fetch: app.fetch,
};
