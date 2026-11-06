-- Validation runs separately from ADD CHECK: its scan must not retain an ACCESS EXCLUSIVE lock.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "model_responses" VALIDATE CONSTRAINT "model_responses_price_source_valid";
--> statement-breakpoint
ALTER TABLE "model_responses" VALIDATE CONSTRAINT "model_responses_predicted_cache_reason_valid";
