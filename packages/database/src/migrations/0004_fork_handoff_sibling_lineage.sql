ALTER TABLE "threads" DROP CONSTRAINT "threads_handoff_origin_required_fields";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_fork_origin_required_fields";--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_fork_origin_required_fields" CHECK ("threads"."origin_type" != 'fork' OR "threads"."origin_turn_id" IS NOT NULL);