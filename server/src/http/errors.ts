import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Stripe-style error envelope: { error: { type, code, message, param? } }.

export type ApiErrorType =
  | "api_error"
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "idempotency_error";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly type: ApiErrorType,
    readonly code: string,
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        ...(this.param ? { param: this.param } : {}),
      },
    };
  }
}

export function onError(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json(err.toJSON(), err.status);
  console.error(err);
  return c.json(
    new ApiError(
      500,
      "api_error",
      "internal_error",
      "An internal error occurred.",
    ).toJSON(),
    500,
  );
}

export function onNotFound(c: Context) {
  return c.json(
    new ApiError(
      404,
      "invalid_request_error",
      "route_not_found",
      `No route for ${c.req.method} ${c.req.path}.`,
    ).toJSON(),
    404,
  );
}
