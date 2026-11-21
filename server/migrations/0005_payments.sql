CREATE TYPE "public"."payment_attempt_status" AS ENUM('pending', 'sent', 'succeeded', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_status" AS ENUM('requires_confirmation', 'processing', 'succeeded', 'canceled', 'expired');--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"rail" text NOT NULL,
	"payer_alias" text NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'pending' NOT NULL,
	"rail_reference" text,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_rail_reference_key" UNIQUE("rail","rail_reference")
);
--> statement-breakpoint
CREATE TABLE "payment_intent_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"from_status" "payment_intent_status",
	"to_status" "payment_intent_status" NOT NULL,
	"attempt_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "payment_intent_status" NOT NULL,
	"description" text,
	"merchant_reference" text,
	"metadata" jsonb NOT NULL,
	"latest_attempt_id" uuid,
	"fee" bigint,
	"last_payment_error" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"succeeded_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_amount_positive" CHECK ("payment_intents"."amount" > 0),
	CONSTRAINT "payment_intents_currency_sdg" CHECK ("payment_intents"."currency" = 'SDG'),
	CONSTRAINT "payment_intents_fee_range" CHECK ("payment_intents"."fee" IS NULL OR ("payment_intents"."fee" >= 0 AND "payment_intents"."fee" <= "payment_intents"."amount")),
	CONSTRAINT "payment_intents_expires_after_created" CHECK ("payment_intents"."expires_at" > "payment_intents"."created_at")
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent_transitions" ADD CONSTRAINT "payment_intent_transitions_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent_transitions" ADD CONSTRAINT "payment_intent_transitions_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_attempts_intent_idx" ON "payment_attempts" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE INDEX "payment_intent_transitions_intent_idx" ON "payment_intent_transitions" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE INDEX "payment_intents_merchant_list_idx" ON "payment_intents" USING btree ("merchant_id","livemode","id");--> statement-breakpoint
CREATE INDEX "payment_intents_expiry_idx" ON "payment_intents" USING btree ("expires_at") WHERE "payment_intents"."status" = 'requires_confirmation';