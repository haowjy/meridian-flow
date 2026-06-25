ALTER TABLE "model_responses" DROP CONSTRAINT "model_responses_price_source_valid";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_status_valid";--> statement-breakpoint
ALTER TABLE "model_responses" ALTER COLUMN "input_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "model_responses" ALTER COLUMN "output_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "status" SET DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "total_input_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "total_output_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "total_cost_usd" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "total_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD COLUMN "provider_data" jsonb;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "response_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "request_params" jsonb;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "response_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_price_source_valid" CHECK ("model_responses"."price_source" IN ('computed', 'provider_reported', 'configured_rate', 'unknown'));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_status_valid" CHECK ("threads"."status" IN ('idle', 'active', 'blocked', 'error', 'archived'));