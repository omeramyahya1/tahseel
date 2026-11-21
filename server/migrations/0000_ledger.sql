CREATE TYPE "public"."ledger_account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense', 'memo');--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"type" "ledger_account_type" NOT NULL,
	"currency" char(3) NOT NULL,
	"livemode" boolean NOT NULL,
	"merchant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_code_livemode_key" UNIQUE("code","livemode"),
	CONSTRAINT "ledger_accounts_id_currency_livemode_key" UNIQUE("id","currency","livemode"),
	CONSTRAINT "ledger_accounts_currency_sdg" CHECK ("ledger_accounts"."currency" = 'SDG')
);
--> statement-breakpoint
CREATE TABLE "ledger_journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"livemode" boolean NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_journals_id_livemode_key" UNIQUE("id","livemode"),
	CONSTRAINT "ledger_journals_source_kind_key" UNIQUE("source_type","source_id","kind")
);
--> statement-breakpoint
CREATE TABLE "ledger_postings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"livemode" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_postings_amount_nonzero" CHECK ("ledger_postings"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_journal_fk" FOREIGN KEY ("journal_id","livemode") REFERENCES "public"."ledger_journals"("id","livemode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_account_fk" FOREIGN KEY ("account_id","currency","livemode") REFERENCES "public"."ledger_accounts"("id","currency","livemode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_postings_account_id_idx" ON "ledger_postings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_postings_journal_id_idx" ON "ledger_postings" USING btree ("journal_id");