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
