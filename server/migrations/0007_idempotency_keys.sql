CREATE TYPE "public"."idempotency_key_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"status" "idempotency_key_status" DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_merchant_id_livemode_key_pk" PRIMARY KEY("merchant_id","livemode","key")
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");