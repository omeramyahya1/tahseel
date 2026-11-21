import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Column names are snake_case via `casing: "snake_case"` (client + drizzle.config).
// Ledger invariants that Drizzle can't express (balanced journals, append-only)
// live in custom SQL migrations; see docs/adr/0003-ledger-design.md.

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Read-only from the app's point of view (set by triggers).
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
});

export const merchantStatus = pgEnum("merchant_status", [
  "active",
  "suspended",
]);

export const merchants = pgTable(
  "merchants",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    status: merchantStatus().notNull().default("active"),
    // ISO 20022 creditor: where payers pay directly (funds never touch Tahseel).
    creditorBankCode: text().notNull(),
    creditorAccount: text().notNull(),
    // Pricing: fee = amount * feeBps / 10_000 + feeFixed, clamped to [feeMin, feeMax].
    feeBps: integer().notNull().default(0),
    feeFixed: bigint({ mode: "bigint" }).notNull().default(sql`0`),
    feeMin: bigint({ mode: "bigint" }),
    feeMax: bigint({ mode: "bigint" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("merchants_name_nonempty", sql`length(trim(${t.name})) > 0`),
    check(
      "merchants_creditor_nonempty",
      sql`length(trim(${t.creditorBankCode})) > 0 AND length(trim(${t.creditorAccount})) > 0`,
    ),
    check("merchants_fee_bps_range", sql`${t.feeBps} BETWEEN 0 AND 10000`),
    check("merchants_fee_fixed_nonneg", sql`${t.feeFixed} >= 0`),
    check(
      "merchants_fee_min_nonneg",
      sql`${t.feeMin} IS NULL OR ${t.feeMin} >= 0`,
    ),
    check(
      "merchants_fee_max_nonneg",
      sql`${t.feeMax} IS NULL OR ${t.feeMax} >= 0`,
    ),
    check(
      "merchants_fee_min_le_max",
      sql`${t.feeMin} IS NULL OR ${t.feeMax} IS NULL OR ${t.feeMin} <= ${t.feeMax}`,
    ),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().primaryKey(),
    merchantId: uuid()
      .notNull()
      .references(() => merchants.id),
    livemode: boolean().notNull(),
    // HMAC-SHA256(pepper, secret). The secret itself is never stored.
    keyHash: bytea().notNull(),
    last4: char({ length: 4 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("api_keys_key_hash_key").on(t.keyHash),
    index("api_keys_merchant_id_idx").on(t.merchantId),
  ],
);

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const ledgerAccountType = pgEnum("ledger_account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
  "memo",
]);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid().primaryKey(),
    code: text().notNull(),
    type: ledgerAccountType().notNull(),
    currency: char({ length: 3 }).notNull(),
    livemode: boolean().notNull(),
    merchantId: uuid().references(() => merchants.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_accounts_code_livemode_key").on(t.code, t.livemode),
    unique("ledger_accounts_id_currency_livemode_key").on(
      t.id,
      t.currency,
      t.livemode,
    ),
    // This database holds the SDG ledger only. USD gets its own database.
    check("ledger_accounts_currency_sdg", sql`${t.currency} = 'SDG'`),
  ],
);

export const ledgerJournals = pgTable(
  "ledger_journals",
  {
    id: uuid().primaryKey(),
    kind: text().notNull(),
    livemode: boolean().notNull(),
    sourceType: text().notNull(),
    sourceId: text().notNull(),
    description: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Top-level transaction that created the journal, stamped by trigger.
    // Postings may only be added by that same transaction (TL004).
    createdXactId: xid8(),
  },
  (t) => [
    unique("ledger_journals_id_livemode_key").on(t.id, t.livemode),
    // One journal of each kind per source object: re-posting is a no-op.
    unique("ledger_journals_source_kind_key").on(
      t.sourceType,
      t.sourceId,
      t.kind,
    ),
  ],
);

export const ledgerPostings = pgTable(
  "ledger_postings",
  {
    id: uuid().primaryKey(),
    journalId: uuid().notNull(),
    accountId: uuid().notNull(),
    // Minor units. Debit is positive, credit is negative.
    amount: bigint({ mode: "bigint" }).notNull(),
    currency: char({ length: 3 }).notNull(),
    livemode: boolean().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ledger_postings_amount_nonzero", sql`${t.amount} <> 0`),
    // Composite FKs: a posting can't mix modes with its journal, or mix
    // currency/mode with its account.
    foreignKey({
      name: "ledger_postings_journal_fk",
      columns: [t.journalId, t.livemode],
      foreignColumns: [ledgerJournals.id, ledgerJournals.livemode],
    }),
    foreignKey({
      name: "ledger_postings_account_fk",
      columns: [t.accountId, t.currency, t.livemode],
      foreignColumns: [
        ledgerAccounts.id,
        ledgerAccounts.currency,
        ledgerAccounts.livemode,
      ],
    }),
    index("ledger_postings_account_id_idx").on(t.accountId),
    index("ledger_postings_journal_id_idx").on(t.journalId),
  ],
);

// ---------------------------------------------------------------------------
// Jobs (outbox + work queue)
// ---------------------------------------------------------------------------

export const jobStatus = pgEnum("job_status", [
  "pending",
  "running",
  "done",
  "dead",
]);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey(),
    queue: text().notNull(),
    kind: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: jobStatus().notNull().default("pending"),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(10),
    lockedUntil: timestamp({ withTimezone: true }),
    lastError: text(),
    // Optional: enqueueing twice with the same key is a no-op.
    dedupeKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("jobs_dedupe_key_key").on(t.dedupeKey),
    index("jobs_claim_idx")
      .on(t.queue, t.runAt)
      .where(sql`${t.status} IN ('pending', 'running')`),
  ],
);

// ---------------------------------------------------------------------------
// Events (append-only, range-partitioned by month on created_at)
// ---------------------------------------------------------------------------
// Drizzle can't declare partitioned tables; the generated migration is
// edited by hand to add PARTITION BY (see migrations/0004_events.sql).

export const events = pgTable(
  "events",
  {
    id: uuid().notNull(),
    type: text().notNull(),
    merchantId: uuid()
      .notNull()
      .references(() => merchants.id),
    livemode: boolean().notNull(),
    data: jsonb().$type<{ object: Record<string, unknown> }>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.createdAt, t.id] }),
    index("events_id_idx").on(t.id),
    index("events_merchant_idx").on(t.merchantId, t.livemode, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
// State machine and immutable columns are enforced by triggers in
// migrations/0006_payments_invariants.sql (mirrors modules/payments/status.ts).

export const paymentIntentStatus = pgEnum("payment_intent_status", [
  "requires_confirmation",
  "processing",
  "succeeded",
  "canceled",
  "expired",
]);

export const paymentAttemptStatus = pgEnum("payment_attempt_status", [
  "pending", // created, request-to-pay not yet accepted by the rail
  "sent", // rail accepted the request-to-pay; awaiting the payer
  "succeeded",
  "declined",
  "expired",
]);

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: uuid().primaryKey(),
    merchantId: uuid()
      .notNull()
      .references(() => merchants.id),
    livemode: boolean().notNull(),
    amount: bigint({ mode: "bigint" }).notNull(),
    currency: char({ length: 3 }).notNull(),
    status: paymentIntentStatus().notNull(),
    description: text(),
    merchantReference: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull(),
    // Latest confirm attempt; FK added in the custom migration (circular).
    latestAttemptId: uuid(),
    // Accrued fee, set when the payment succeeds.
    fee: bigint({ mode: "bigint" }),
    lastPaymentError: jsonb().$type<{ code: string; message: string }>(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    succeededAt: timestamp({ withTimezone: true }),
    canceledAt: timestamp({ withTimezone: true }),
    expiredAt: timestamp({ withTimezone: true }),
    reconciledAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("payment_intents_amount_positive", sql`${t.amount} > 0`),
    check("payment_intents_currency_sdg", sql`${t.currency} = 'SDG'`),
    check(
      "payment_intents_fee_range",
      sql`${t.fee} IS NULL OR (${t.fee} >= 0 AND ${t.fee} <= ${t.amount})`,
    ),
    check(
      "payment_intents_expires_after_created",
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
    index("payment_intents_merchant_list_idx").on(
      t.merchantId,
      t.livemode,
      t.id,
    ),
    index("payment_intents_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'requires_confirmation'`),
  ],
);

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid().primaryKey(),
    paymentIntentId: uuid()
      .notNull()
      .references(() => paymentIntents.id),
    livemode: boolean().notNull(),
    rail: text().notNull(),
    payerAlias: text().notNull(),
    status: paymentAttemptStatus().notNull().default("pending"),
    railReference: text(),
    failureCode: text(),
    failureMessage: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("payment_attempts_rail_reference_key").on(t.rail, t.railReference),
    index("payment_attempts_intent_idx").on(t.paymentIntentId),
  ],
);

export const paymentIntentTransitions = pgTable(
  "payment_intent_transitions",
  {
    id: uuid().primaryKey(),
    paymentIntentId: uuid()
      .notNull()
      .references(() => paymentIntents.id),
    fromStatus: paymentIntentStatus(),
    toStatus: paymentIntentStatus().notNull(),
    attemptId: uuid().references(() => paymentAttempts.id),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payment_intent_transitions_intent_idx").on(t.paymentIntentId)],
);

// ---------------------------------------------------------------------------
// Idempotency keys (public API)
// ---------------------------------------------------------------------------

export const idempotencyKeyStatus = pgEnum("idempotency_key_status", [
  "in_progress",
  "completed",
]);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    merchantId: uuid()
      .notNull()
      .references(() => merchants.id),
    livemode: boolean().notNull(),
    key: text().notNull(),
    // Identifies the request that currently owns the key (see http/idempotency.ts).
    claimToken: uuid().notNull(),
    // SHA-256 of method, path and raw body: same key + different request = 422.
    requestHash: bytea().notNull(),
    status: idempotencyKeyStatus().notNull().default("in_progress"),
    responseStatus: integer(),
    responseBody: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.merchantId, t.livemode, t.key] }),
    index("idempotency_keys_created_at_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid().primaryKey(),
    merchantId: uuid()
      .notNull()
      .references(() => merchants.id),
    livemode: boolean().notNull(),
    url: text().notNull(),
    description: text(),
    // Event types, or ["*"] for all.
    enabledEvents: text().array().notNull(),
    // AES-256-GCM via KeyProvider; the signing secret must be recoverable.
    secretEncrypted: bytea().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check(
      "webhook_endpoints_enabled_events_nonempty",
      sql`cardinality(${t.enabledEvents}) > 0`,
    ),
    index("webhook_endpoints_merchant_idx").on(t.merchantId, t.livemode),
  ],
);

export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "pending",
  "succeeded",
  "failed",
]);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid().primaryKey(),
    // No FK: events is partitioned on created_at (microseconds), which can't
    // round-trip through a JS Date. Events are append-only, so the id is stable.
    eventId: uuid().notNull(),
    endpointId: uuid()
      .notNull()
      .references(() => webhookEndpoints.id),
    status: webhookDeliveryStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    lastAttemptAt: timestamp({ withTimezone: true }),
    lastResponseStatus: integer(),
    lastError: text(),
    succeededAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One delivery per (event, endpoint): dispatch is idempotent.
    unique("webhook_deliveries_event_endpoint_key").on(t.eventId, t.endpointId),
  ],
);

export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    id: uuid().primaryKey(),
    deliveryId: uuid()
      .notNull()
      .references(() => webhookDeliveries.id),
    attemptNumber: integer().notNull(),
    requestedAt: timestamp({ withTimezone: true }).notNull(),
    durationMs: integer().notNull(),
    responseStatus: integer(),
    error: text(),
    // First 1 KB of the response body, for debugging.
    responseExcerpt: text(),
  },
  (t) => [index("webhook_delivery_attempts_delivery_idx").on(t.deliveryId)],
);
