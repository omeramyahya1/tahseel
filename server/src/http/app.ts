import { Hono } from "hono";
import type { KeyProvider } from "../crypto/keys";
import type { Db } from "../db/client";
import { type AuthVariables, requireApiKey } from "./auth";
import { onError, onNotFound } from "./errors";

export type AppDeps = { db: Db; keys: KeyProvider };

export type ApiEnv = { Variables: AuthVariables };

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.onError(onError);
  app.notFound(onNotFound);

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/health/db", async (c) => {
    await deps.db.execute("select 1");
    return c.json({ status: "ok" });
  });

  // Public API. Resource routes are mounted here as they're added.
  const v1 = new Hono<ApiEnv>();
  v1.use("*", requireApiKey(deps));
  app.route("/v1", v1);

  return app;
}
