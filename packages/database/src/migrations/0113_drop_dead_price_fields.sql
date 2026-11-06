-- Retire values and a column that nothing writes any more: price_source 'provider_reported' and
-- 'configured_rate' (folded into 'computed'), predicted_cache_reason 'uncached' (folded into the
-- cold 'ttl_unknown'), and the provider_request_id column. Old OpenRouter rows hold generation IDs
-- there, so each non-null value is copied into response_metadata under 'providerRequestId' before
-- the drop. The narrowed checks are added NOT
-- VALID and validated in 0114, so the scan of model_responses holds no ACCESS EXCLUSIVE lock.
-- Backfill runs first so the checks hold for every stored row; no producer writes the old values.
-- Stop every application writer first: the previous release lists provider_request_id in its
-- model_responses inserts and selects, so it fails once the column is gone.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
UPDATE "model_responses" SET "response_metadata" = coalesce("response_metadata", '{}'::jsonb) || jsonb_build_object('providerRequestId', "provider_request_id") WHERE "provider_request_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "model_responses" SET "price_source" = 'computed' WHERE "price_source" IN ('provider_reported', 'configured_rate');
--> statement-breakpoint
UPDATE "model_responses" SET "predicted_cache_reason" = 'ttl_unknown' WHERE "predicted_cache_reason" = 'uncached';
--> statement-breakpoint
ALTER TABLE "model_responses" DROP CONSTRAINT "model_responses_price_source_valid";
--> statement-breakpoint
ALTER TABLE "model_responses" DROP CONSTRAINT "model_responses_predicted_cache_reason_valid";
--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_price_source_valid" CHECK ("model_responses"."price_source" IN ('computed', 'unknown')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_predicted_cache_reason_valid" CHECK ("model_responses"."predicted_cache_reason" IN ('reusable_prefix', 'no_response', 'model_changed', 'prompt_epoch', 'image_eviction', 'compaction', 'ttl_unknown', 'ttl_expired', 'summary_transcript', 'fork_cutoff', 'fork_bake_changed', 'facts_unavailable')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "model_responses" DROP COLUMN "provider_request_id";
