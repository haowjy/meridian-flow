ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_body_valid";--> statement-breakpoint
ALTER TABLE "thread_run_leases" DROP CONSTRAINT "thread_run_leases_phase_valid";--> statement-breakpoint
DROP INDEX "turns_pending_placeholders";--> statement-breakpoint
CREATE INDEX "turns_pending_placeholders" ON "turns" USING btree ("id") WHERE "turns"."status" = 'pending' AND "turns"."role" IN ('compaction', 'system');--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_body_valid" CHECK ((CASE WHEN "thread_inbox_messages"."intent" = 'control' THEN "thread_inbox_messages"."body"->>'kind' IN ('compact', 'handoff_brief') ELSE "thread_inbox_messages"."body"->>'kind' IN ('text','context','work_context_refresh') END) IS TRUE);--> statement-breakpoint
ALTER TABLE "thread_run_leases" ADD CONSTRAINT "thread_run_leases_phase_valid" CHECK ("thread_run_leases"."phase" IN ('generating','waiting','compacting','briefing'));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_handoff_origin_turn_required" CHECK ("threads"."origin_type" <> 'handoff' OR "threads"."origin_turn_id" IS NOT NULL);