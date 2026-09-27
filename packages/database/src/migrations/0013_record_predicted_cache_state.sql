ALTER TABLE "model_responses" ADD COLUMN "request_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "predicted_cache_state" text;--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "predicted_cache_reason" text;--> statement-breakpoint
UPDATE "model_responses" SET "predicted_cache_state" = 'cold', "predicted_cache_reason" = 'facts_unavailable';--> statement-breakpoint
ALTER TABLE "model_responses" ALTER COLUMN "predicted_cache_state" SET NOT NULL, ALTER COLUMN "predicted_cache_reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_predicted_cache_state_valid" CHECK ("model_responses"."predicted_cache_state" IN ('warm', 'cold'));--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_predicted_cache_reason_valid" CHECK ("model_responses"."predicted_cache_reason" IN ('reusable_prefix', 'uncached', 'no_response', 'model_changed', 'prompt_epoch', 'image_eviction', 'compaction', 'ttl_unknown', 'ttl_expired', 'fork_cutoff', 'fork_bake_changed', 'facts_unavailable'));
