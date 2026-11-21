-- Existing rows get a random token (hand-edited: the generated
-- "ADD COLUMN ... NOT NULL" fails on a non-empty table). New rows always
-- get an explicit token from the app, so the default is dropped afterwards.
ALTER TABLE "idempotency_keys" ADD COLUMN "claim_token" uuid NOT NULL DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "claim_token" DROP DEFAULT;
