/*
 * B3: Durable billing/audit fields on model_responses for provider reconciliation.
 */
ALTER TABLE "model_responses" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "price_source" text DEFAULT 'computed' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "pricing_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_price_source_valid" CHECK ("price_source" IN ('computed', 'provider_reported', 'unknown'));
