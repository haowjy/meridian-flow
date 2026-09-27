ALTER TABLE "model_responses" ADD COLUMN "time_to_first_token_ms" bigint;--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "generation_ms" bigint;