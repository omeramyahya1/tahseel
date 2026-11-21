import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";
import { PaymentError, type PaymentErrorCode } from "../modules/payments";
import { WebhookError, type WebhookErrorCode } from "../modules/webhooks";

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

const PAYMENT_ERRORS: Record<
  PaymentErrorCode,
  [ContentfulStatusCode, ApiErrorType]
> = {
  payment_intent_not_found: [404, "invalid_request_error"],
  payment_intent_unexpected_state: [400, "invalid_request_error"],
  payment_intent_expired: [400, "invalid_request_error"],
  rail_unavailable: [503, "api_error"],
};

const WEBHOOK_ERRORS: Record<WebhookErrorCode, ContentfulStatusCode> = {
  webhook_endpoint_not_found: 404,
  url_invalid: 400,
  too_many_webhook_endpoints: 400,
};

export function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof WebhookError) {
    return new ApiError(
      WEBHOOK_ERRORS[err.code],
      "invalid_request_error",
      err.code,
      err.message,
      err.param,
    );
  }
  if (err instanceof PaymentError) {
    const [status, type] = PAYMENT_ERRORS[err.code];
    return new ApiError(status, type, err.code, err.message);
  }
  if (err instanceof HTTPException && err.status < 500) {
    // e.g. malformed JSON from Hono's body parser.
    return new ApiError(
      err.status as ContentfulStatusCode,
      "invalid_request_error",
      "invalid_request",
      err.message || "The request could not be parsed.",
    );
  }
  return null;
}

/** Turns the first Zod issue into a 400 naming the offending parameter. */
export function validationError(error: ZodError): ApiError {
  const issue = error.issues[0];
  const param = issue?.path.join(".") || undefined;
  const missing =
    issue?.code === "invalid_type" && issue.message.includes("undefined");
  return new ApiError(
    400,
    "invalid_request_error",
    missing ? "parameter_missing" : "parameter_invalid",
    param
      ? `${param}: ${issue?.message}`
      : (issue?.message ?? "Invalid request."),
    param,
  );
}

export function onError(err: Error, c: Context) {
  const apiError = toApiError(err);
  if (apiError) return c.json(apiError.toJSON(), apiError.status);
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
