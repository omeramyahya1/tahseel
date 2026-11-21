CREATE TYPE "public"."merchant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"last4" char(4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_key" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "merchant_status" DEFAULT 'active' NOT NULL,
	"creditor_bank_code" text NOT NULL,
	"creditor_account" text NOT NULL,
	"fee_bps" integer DEFAULT 0 NOT NULL,
	"fee_fixed" bigint DEFAULT 0 NOT NULL,
	"fee_min" bigint,
	"fee_max" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_name_nonempty" CHECK (length(trim("merchants"."name")) > 0),
	CONSTRAINT "merchants_creditor_nonempty" CHECK (length(trim("merchants"."creditor_bank_code")) > 0 AND length(trim("merchants"."creditor_account")) > 0),
	CONSTRAINT "merchants_fee_bps_range" CHECK ("merchants"."fee_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "merchants_fee_fixed_nonneg" CHECK ("merchants"."fee_fixed" >= 0),
	CONSTRAINT "merchants_fee_min_nonneg" CHECK ("merchants"."fee_min" IS NULL OR "merchants"."fee_min" >= 0),
	CONSTRAINT "merchants_fee_max_nonneg" CHECK ("merchants"."fee_max" IS NULL OR "merchants"."fee_max" >= 0),
	CONSTRAINT "merchants_fee_min_le_max" CHECK ("merchants"."fee_min" IS NULL OR "merchants"."fee_max" IS NULL OR "merchants"."fee_min" <= "merchants"."fee_max")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_merchant_id_idx" ON "api_keys" USING btree ("merchant_id");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;