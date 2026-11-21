import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import type { KeyProvider } from "../crypto/keys";
import type { Db } from "../db/client";
import type { PaymentsDeps } from "../modules/payments";
import type { WebhookDeps } from "../modules/webhooks";
import { requireApiKey } from "./auth";
import { onError, onNotFound } from "./errors";
import { type IdempotencyVariables, idempotency } from "./idempotency";
import { eventRoutes } from "./routes/events";
import { paymentIntentRoutes } from "./routes/payment-intents";
import { webhookEndpointRoutes } from "./routes/webhook-endpoints";

export type AppDeps = {
  db: Db;
  keys: KeyProvider;
  payments: PaymentsDeps;
  webhooks: WebhookDeps;
};

export type ApiEnv = { Variables: IdempotencyVariables };

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.onError(onError);
  app.notFound(onNotFound);

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/health/db", async (c) => {
    await deps.db.execute("select 1");
    return c.json({ status: "ok" });
  });

  // Public API.
  const v1 = new OpenAPIHono<ApiEnv>();
  v1.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Your secret key: `sk_test_…` or `sk_live_…`.",
  });
  v1.route("/", paymentIntentRoutes(deps));
  v1.route("/", eventRoutes(deps));
  v1.route("/", webhookEndpointRoutes(deps));

  // The spec is public (no API key), so it's registered before /v1 auth.
  app.get("/v1/openapi.json", (c) =>
    c.json(
      v1.getOpenAPI31Document({
        openapi: "3.1.0",
        info: {
          title: "Tahseel API",
          version: "v1",
          description:
            "Payments for Sudan. Amounts are integers in piasters; timestamps are ISO 8601 UTC.",
        },
        servers: [{ url: "/v1" }],
      }),
    ),
  );

  const guarded = new Hono<ApiEnv>();
  guarded.use("*", requireApiKey(deps));
  guarded.use("*", idempotency(deps));
  guarded.route("/", v1);
  app.route("/v1", guarded);

  return app;
}
