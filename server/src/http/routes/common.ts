import type { z } from "@hono/zod-openapi";
import { ErrorResponse } from "../schemas";

export const security = [{ bearerAuth: [] }];

export const errorResponses = {
  400: {
    description: "Invalid request",
    content: { "application/json": { schema: ErrorResponse } },
  },
  401: {
    description: "Missing or invalid API key",
    content: { "application/json": { schema: ErrorResponse } },
  },
  404: {
    description: "Not found",
    content: { "application/json": { schema: ErrorResponse } },
  },
};

export const ok = (description: string, schema: z.ZodTypeAny) => ({
  200: { description, content: { "application/json": { schema } } },
});
