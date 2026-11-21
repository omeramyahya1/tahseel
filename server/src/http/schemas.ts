import { z } from "@hono/zod-openapi";

// Public API schemas. Amounts are integers in minor units (piasters);
// timestamps are ISO 8601 UTC strings.

export const Amount = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .openapi({
    description: "Amount in minor units (piasters).",
    example: 150000,
  });

export const Metadata = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 50, "at most 50 keys")
  .openapi({
    description: "Up to 50 string key/value pairs for your own use.",
    example: { order_id: "1042" },
  });

export const PayerAlias = z
  .string()
  .regex(/^\+249\d{9}$/, "must be a Sudanese phone number like +249912345678")
  .openapi({ example: "+249912345678" });

const Timestamp = z.string().openapi({ format: "date-time" });

export const ErrorResponse = z
  .object({
    error: z.object({
      type: z.enum([
        "api_error",
        "authentication_error",
        "permission_error",
        "invalid_request_error",
        "idempotency_error",
      ]),
      code: z.string(),
      message: z.string(),
      param: z.string().optional(),
    }),
  })
  .openapi("Error");

export const PaymentIntent = z
  .object({
    id: z.string().openapi({ example: "pi_01JDZ8Q0Y3M7S5K2V4T6W8X0YZ" }),
    object: z.literal("payment_intent"),
    livemode: z.boolean(),
    status: z.enum([
      "requires_confirmation",
      "processing",
      "succeeded",
      "canceled",
      "expired",
    ]),
    amount: z.number().int(),
    currency: z.literal("SDG"),
    fee: z.number().int().nullable().openapi({
      description: "Fee accrued by Tahseel, set when the payment succeeds.",
    }),
    description: z.string().nullable(),
    merchant_reference: z.string().nullable(),
    metadata: z.record(z.string(), z.string()),
    payer: z.object({ alias: z.string() }).nullable(),
    latest_attempt: z
      .object({
        id: z.string(),
        status: z.enum(["pending", "sent", "succeeded", "declined", "expired"]),
        rail: z.string(),
        rail_reference: z.string().nullable(),
        failure_code: z.string().nullable(),
        failure_message: z.string().nullable(),
        created_at: Timestamp,
      })
      .nullable(),
    last_payment_error: z
      .object({ code: z.string(), message: z.string() })
      .nullable(),
    expires_at: Timestamp,
    succeeded_at: Timestamp.nullable(),
    canceled_at: Timestamp.nullable(),
    expired_at: Timestamp.nullable(),
    created_at: Timestamp,
  })
  .openapi("PaymentIntent");

export const Event = z
  .object({
    id: z.string().openapi({ example: "evt_01JDZ8Q0Y3M7S5K2V4T6W8X0YZ" }),
    object: z.literal("event"),
    type: z.string().openapi({ example: "payment_intent.succeeded" }),
    livemode: z.boolean(),
    created_at: Timestamp,
    data: z.object({
      object: z.record(z.string(), z.unknown()).openapi({
        description: "The API object as it was when the event happened.",
      }),
    }),
  })
  .openapi("Event");

export const WebhookEndpoint = z
  .object({
    id: z.string().openapi({ example: "we_01JDZ8Q0Y3M7S5K2V4T6W8X0YZ" }),
    object: z.literal("webhook_endpoint"),
    livemode: z.boolean(),
    url: z.string(),
    description: z.string().nullable(),
    enabled_events: z.array(z.string()),
    created_at: Timestamp,
    secret: z.string().optional().openapi({
      description:
        "Signing secret (`whsec_…`). Only returned when the endpoint is created.",
    }),
  })
  .openapi("WebhookEndpoint");

export const DeletedObject = z.object({
  id: z.string(),
  object: z.string(),
  deleted: z.literal(true),
});

export const IdempotencyHeaders = z.object({
  "idempotency-key": z.string().max(255).openapi({
    description:
      "Unique per logical request; retries with the same key are safe.",
    example: "order-1042-attempt-1",
  }),
});

export const listOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    object: z.literal("list"),
    data: z.array(item),
    has_more: z.boolean(),
  });
