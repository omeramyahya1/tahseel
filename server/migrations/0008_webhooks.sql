CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_response_status" integer,
	"last_error" text,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_event_endpoint_key" UNIQUE("event_id","endpoint_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"response_status" integer,
	"error" text,
	"response_excerpt" text
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"enabled_events" text[] NOT NULL,
	"secret_encrypted" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "webhook_endpoints_enabled_events_nonempty" CHECK (cardinality("webhook_endpoints"."enabled_events") > 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_attempts_delivery_idx" ON "webhook_delivery_attempts" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_merchant_idx" ON "webhook_endpoints" USING btree ("merchant_id","livemode");--> statement-breakpoint
-- Hand-written: the attempt log is append-only.
CREATE TRIGGER webhook_delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON webhook_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER webhook_delivery_attempts_no_truncate
  BEFORE TRUNCATE ON webhook_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
