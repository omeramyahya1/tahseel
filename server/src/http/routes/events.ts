import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { fromPublicId } from "../../lib/ids";
import {
  EVENT_TYPES,
  getEvent,
  listEvents,
  presentEvent,
} from "../../modules/events";
import type { AppDeps } from "../app";
import { ApiError, validationError } from "../errors";
import type { IdempotencyVariables } from "../idempotency";
import { Event, listOf } from "../schemas";
import { errorResponses, ok, security } from "./common";

const tags = ["Events"];

const IdParam = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "evt_01JDZ8Q0Y3M7S5K2V4T6W8X0YZ",
  }),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  starting_after: z.string().optional(),
  type: z.enum(EVENT_TYPES).optional(),
});

const routes = {
  retrieve: createRoute({
    method: "get",
    path: "/events/{id}",
    tags,
    security,
    summary: "Retrieve an event",
    request: { params: IdParam },
    responses: { ...ok("The event", Event), ...errorResponses },
  }),
  list: createRoute({
    method: "get",
    path: "/events",
    tags,
    security,
    summary: "List events, newest first",
    request: { query: ListQuery },
    responses: { ...ok("A page of events", listOf(Event)), ...errorResponses },
  }),
};

function notFound(param = "id"): never {
  throw new ApiError(
    404,
    "invalid_request_error",
    "event_not_found",
    "No such event.",
    param,
  );
}

export function eventRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<{ Variables: IdempotencyVariables }>({
    defaultHook: (result) => {
      if (!result.success) throw validationError(result.error);
    },
  });
  const scope = (c: { var: IdempotencyVariables }) => ({
    merchantId: c.var.merchant.id,
    livemode: c.var.livemode,
  });

  app.openapi(routes.retrieve, async (c) => {
    const id = fromPublicId("evt", c.req.valid("param").id) ?? notFound();
    const event = await getEvent(deps.db, scope(c), id);
    if (!event) notFound();
    return c.json(presentEvent(event), 200);
  });

  app.openapi(routes.list, async (c) => {
    const query = c.req.valid("query");
    const startingAfter = query.starting_after
      ? (fromPublicId("evt", query.starting_after) ??
        notFound("starting_after"))
      : undefined;
    const page = await listEvents(deps.db, scope(c), {
      limit: query.limit,
      ...(startingAfter ? { startingAfter } : {}),
      ...(query.type ? { type: query.type } : {}),
    });
    if (!page) notFound("starting_after");
    return c.json(
      {
        object: "list" as const,
        data: page.data.map(presentEvent),
        has_more: page.hasMore,
      },
      200,
    );
  });

  return app;
}
