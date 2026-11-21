import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { fromPublicId, toPublicId } from "../../lib/ids";
import { EVENT_TYPES } from "../../modules/events";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  presentWebhookEndpoint,
} from "../../modules/webhooks";
import type { AppDeps } from "../app";
import { ApiError, validationError } from "../errors";
import { type IdempotencyVariables, idempotentTx } from "../idempotency";
import {
  DeletedObject,
  IdempotencyHeaders,
  listOf,
  WebhookEndpoint,
} from "../schemas";
import { errorResponses, ok, security } from "./common";

const tags = ["Webhook endpoints"];

const IdParam = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "we_01JDZ8Q0Y3M7S5K2V4T6W8X0YZ",
  }),
});

const CreateBody = z
  .object({
    url: z.string().max(2048).openapi({
      description:
        "Where events are POSTed. HTTPS is required in live mode; private and loopback addresses are rejected.",
      example: "https://shop.example/webhooks/tahseel",
    }),
    enabled_events: z
      .array(z.enum(["*", ...EVENT_TYPES]))
      .min(1)
      .openapi({
        description: 'Event types to receive, or ["*"] for all.',
        example: ["payment_intent.succeeded", "payment_intent.payment_failed"],
      }),
    description: z.string().max(500).optional(),
  })
  .strict();

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  starting_after: z.string().optional(),
});

const routes = {
  create: createRoute({
    method: "post",
    path: "/webhook_endpoints",
    tags,
    security,
    summary: "Create a webhook endpoint",
    description:
      "The response includes the signing `secret`, which is shown only once. Each delivery carries `Tahseel-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + '.' + raw body)>`.",
    request: {
      headers: IdempotencyHeaders,
      body: {
        content: { "application/json": { schema: CreateBody } },
        required: true,
      },
    },
    responses: {
      ...ok("The endpoint, with its secret", WebhookEndpoint),
      ...errorResponses,
    },
  }),
  retrieve: createRoute({
    method: "get",
    path: "/webhook_endpoints/{id}",
    tags,
    security,
    summary: "Retrieve a webhook endpoint",
    request: { params: IdParam },
    responses: { ...ok("The endpoint", WebhookEndpoint), ...errorResponses },
  }),
  list: createRoute({
    method: "get",
    path: "/webhook_endpoints",
    tags,
    security,
    summary: "List webhook endpoints",
    request: { query: ListQuery },
    responses: {
      ...ok("A page of endpoints", listOf(WebhookEndpoint)),
      ...errorResponses,
    },
  }),
  delete: createRoute({
    method: "delete",
    path: "/webhook_endpoints/{id}",
    tags,
    security,
    summary: "Delete a webhook endpoint",
    request: { params: IdParam },
    responses: { ...ok("Deleted", DeletedObject), ...errorResponses },
  }),
};

function notFound(param = "id"): never {
  throw new ApiError(
    404,
    "invalid_request_error",
    "webhook_endpoint_not_found",
    "No such webhook endpoint.",
    param,
  );
}

export function webhookEndpointRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<{ Variables: IdempotencyVariables }>({
    defaultHook: (result) => {
      if (!result.success) throw validationError(result.error);
    },
  });
  const scope = (c: { var: IdempotencyVariables }) => ({
    merchantId: c.var.merchant.id,
    livemode: c.var.livemode,
  });
  const parseId = (id: string) => fromPublicId("we", id) ?? notFound();

  app.openapi(routes.create, async (c) => {
    const body = c.req.valid("json");
    const result = await idempotentTx(
      c,
      deps,
      200,
      async (tx) => {
        const { endpoint, secret } = await createWebhookEndpoint(
          tx,
          deps.webhooks,
          {
            ...scope(c),
            url: body.url,
            description: body.description ?? null,
            enabledEvents: body.enabled_events,
          },
        );
        return { ...presentWebhookEndpoint(endpoint), secret };
      },
      // Never store the signing secret in plaintext in idempotency_keys.
      { secretFields: ["secret"] },
    );
    return c.json(result, 200);
  });

  app.openapi(routes.retrieve, async (c) => {
    const endpoint = await getWebhookEndpoint(
      deps.db,
      scope(c),
      parseId(c.req.valid("param").id),
    );
    if (!endpoint) notFound();
    return c.json(presentWebhookEndpoint(endpoint), 200);
  });

  app.openapi(routes.list, async (c) => {
    const query = c.req.valid("query");
    const startingAfter = query.starting_after
      ? (fromPublicId("we", query.starting_after) ?? notFound("starting_after"))
      : undefined;
    const page = await listWebhookEndpoints(deps.db, scope(c), {
      limit: query.limit,
      ...(startingAfter ? { startingAfter } : {}),
    });
    return c.json(
      {
        object: "list" as const,
        data: page.data.map(presentWebhookEndpoint),
        has_more: page.hasMore,
      },
      200,
    );
  });

  app.openapi(routes.delete, async (c) => {
    const id = parseId(c.req.valid("param").id);
    if (!(await deleteWebhookEndpoint(deps.db, scope(c), id))) notFound();
    return c.json(
      {
        id: toPublicId("we", id),
        object: "webhook_endpoint",
        deleted: true as const,
      },
      200,
    );
  });

  return app;
}
