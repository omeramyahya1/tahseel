import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { fromPublicId } from "../../lib/ids";
import {
  cancelPaymentIntent,
  confirmPaymentIntent,
  createPaymentIntent,
  getPaymentIntent,
  listPaymentIntents,
  MAX_EXPIRY_MS,
  MIN_EXPIRY_MS,
  presentPaymentIntent,
} from "../../modules/payments";
import type { AppDeps } from "../app";
import { ApiError, validationError } from "../errors";
import { type IdempotencyVariables, idempotentTx } from "../idempotency";
import {
  Amount,
  IdempotencyHeaders,
  listOf,
  Metadata,
  PayerAlias,
  PaymentIntent,
} from "../schemas";
import { errorResponses as errors, ok, security } from "./common";

const tags = ["Payment intents"];
const IdParam = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "pi_01JDZ8Q0Y3M7S5K2V4T6W8X0YZ",
  }),
});

const CreateBody = z
  .object({
    amount: Amount,
    currency: z.literal("SDG"),
    description: z.string().max(1000).optional(),
    merchant_reference: z.string().max(255).optional().openapi({
      description: "Your own reference, e.g. an order number.",
    }),
    metadata: Metadata.optional(),
    expires_at: z.iso.datetime({ offset: true }).optional().openapi({
      description:
        "When the payer can no longer pay. 1 minute to 7 days from now; defaults to 15 minutes.",
    }),
  })
  .strict();

const ConfirmBody = z
  .object({ payer: z.object({ alias: PayerAlias }).strict() })
  .strict();

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  starting_after: z.string().optional().openapi({
    description: "A payment intent ID: return intents created before it.",
  }),
});

const routes = {
  create: createRoute({
    method: "post",
    path: "/payment_intents",
    tags,
    security,
    summary: "Create a payment intent",
    request: {
      headers: IdempotencyHeaders,
      body: {
        content: { "application/json": { schema: CreateBody } },
        required: true,
      },
    },
    responses: {
      ...ok("The created payment intent", PaymentIntent),
      ...errors,
    },
  }),
  retrieve: createRoute({
    method: "get",
    path: "/payment_intents/{id}",
    tags,
    security,
    summary: "Retrieve a payment intent",
    request: { params: IdParam },
    responses: { ...ok("The payment intent", PaymentIntent), ...errors },
  }),
  list: createRoute({
    method: "get",
    path: "/payment_intents",
    tags,
    security,
    summary: "List payment intents, newest first",
    request: { query: ListQuery },
    responses: {
      ...ok("A page of payment intents", listOf(PaymentIntent)),
      ...errors,
    },
  }),
  confirm: createRoute({
    method: "post",
    path: "/payment_intents/{id}/confirm",
    tags,
    security,
    summary: "Confirm a payment intent: send a request-to-pay to the payer",
    description:
      "Moves the intent to `processing`. The payer approves in their bank app; the result arrives as a webhook. In test mode, the payer alias picks the outcome: +249900000001 succeeds, +249900000002 declines, +249900000003 never responds, +249900000004 is an unknown alias.",
    request: {
      headers: IdempotencyHeaders,
      params: IdParam,
      body: {
        content: { "application/json": { schema: ConfirmBody } },
        required: true,
      },
    },
    responses: {
      ...ok("The payment intent, now processing", PaymentIntent),
      ...errors,
    },
  }),
  cancel: createRoute({
    method: "post",
    path: "/payment_intents/{id}/cancel",
    tags,
    security,
    summary: "Cancel an unconfirmed payment intent",
    request: { headers: IdempotencyHeaders, params: IdParam },
    responses: {
      ...ok("The canceled payment intent", PaymentIntent),
      ...errors,
    },
  }),
};

function notFound(): never {
  throw new ApiError(
    404,
    "invalid_request_error",
    "payment_intent_not_found",
    "No such payment intent.",
    "id",
  );
}

const parseId = (publicId: string) =>
  fromPublicId("pi", publicId) ?? notFound();

export function paymentIntentRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<{ Variables: IdempotencyVariables }>({
    defaultHook: (result) => {
      if (!result.success) throw validationError(result.error);
    },
  });

  app.openapi(routes.create, async (c) => {
    const body = c.req.valid("json");
    let expiresAt: Date | undefined;
    if (body.expires_at) {
      expiresAt = new Date(body.expires_at);
      const ttl = expiresAt.getTime() - Date.now();
      if (ttl < MIN_EXPIRY_MS || ttl > MAX_EXPIRY_MS) {
        throw new ApiError(
          400,
          "invalid_request_error",
          "parameter_invalid",
          "expires_at must be between 1 minute and 7 days from now.",
          "expires_at",
        );
      }
    }
    const result = await idempotentTx(c, deps.db, 200, async (tx) => {
      const { intent, attempt } = await createPaymentIntent(tx, deps.payments, {
        merchantId: c.var.merchant.id,
        livemode: c.var.livemode,
        amount: BigInt(body.amount),
        description: body.description ?? null,
        merchantReference: body.merchant_reference ?? null,
        metadata: body.metadata ?? {},
        ...(expiresAt ? { expiresAt } : {}),
      });
      return presentPaymentIntent(intent, attempt);
    });
    return c.json(result, 200);
  });

  app.openapi(routes.retrieve, async (c) => {
    const id = parseId(c.req.valid("param").id);
    const found = await getPaymentIntent(
      deps.db,
      { merchantId: c.var.merchant.id, livemode: c.var.livemode },
      id,
    );
    if (!found) notFound();
    return c.json(presentPaymentIntent(found.intent, found.attempt), 200);
  });

  app.openapi(routes.list, async (c) => {
    const query = c.req.valid("query");
    const startingAfter = query.starting_after
      ? (fromPublicId("pi", query.starting_after) ??
        (() => {
          throw new ApiError(
            400,
            "invalid_request_error",
            "parameter_invalid",
            "starting_after must be a payment intent ID.",
            "starting_after",
          );
        })())
      : undefined;
    const page = await listPaymentIntents(
      deps.db,
      { merchantId: c.var.merchant.id, livemode: c.var.livemode },
      { limit: query.limit, ...(startingAfter ? { startingAfter } : {}) },
    );
    return c.json(
      {
        object: "list" as const,
        data: page.data.map((r) => presentPaymentIntent(r.intent, r.attempt)),
        has_more: page.hasMore,
      },
      200,
    );
  });

  app.openapi(routes.confirm, async (c) => {
    const id = parseId(c.req.valid("param").id);
    const { payer } = c.req.valid("json");
    const result = await idempotentTx(c, deps.db, 200, async (tx) => {
      const { intent, attempt } = await confirmPaymentIntent(
        tx,
        deps.payments,
        {
          merchantId: c.var.merchant.id,
          livemode: c.var.livemode,
          id,
          payerAlias: payer.alias,
        },
      );
      return presentPaymentIntent(intent, attempt);
    });
    return c.json(result, 200);
  });

  app.openapi(routes.cancel, async (c) => {
    const id = parseId(c.req.valid("param").id);
    const result = await idempotentTx(c, deps.db, 200, async (tx) => {
      const { intent, attempt } = await cancelPaymentIntent(tx, deps.payments, {
        merchantId: c.var.merchant.id,
        livemode: c.var.livemode,
        id,
      });
      return presentPaymentIntent(intent, attempt);
    });
    return c.json(result, 200);
  });

  return app;
}
