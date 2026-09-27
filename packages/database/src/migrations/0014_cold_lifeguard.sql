ALTER TABLE "thread_execution_reports" RENAME COLUMN "assistant_turn_id" TO "execution_turn_id";--> statement-breakpoint
ALTER TABLE "thread_execution_reports" RENAME COLUMN "terminal_assistant_turn_id" TO "terminal_turn_id";--> statement-breakpoint
ALTER TABLE "thread_run_leases" DROP CONSTRAINT "thread_run_leases_phase_valid";--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT "turns_compaction_model_required";--> statement-breakpoint
ALTER TABLE "thread_execution_reports" DROP CONSTRAINT "thread_execution_reports_assistant_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "thread_execution_reports" DROP CONSTRAINT "thread_execution_reports_terminal_assistant_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "thread_execution_reports" DROP CONSTRAINT "thread_execution_reports_child_turn_fk";
--> statement-breakpoint
DROP INDEX "thread_execution_reports_pending";--> statement-breakpoint
ALTER TABLE "model_responses" ADD COLUMN "request_message_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
-- Historical calls did not save request lengths. Zero conservatively estimates the entire next request.
ALTER TABLE "model_responses" ALTER COLUMN "request_message_count" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_execution_turn_id_turns_id_fk" FOREIGN KEY ("execution_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_terminal_turn_id_turns_id_fk" FOREIGN KEY ("terminal_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_child_turn_fk" FOREIGN KEY ("child_thread_id","execution_turn_id") REFERENCES "public"."turns"("thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_execution_reports_pending" ON "thread_execution_reports" USING btree ("execution_turn_id") WHERE "thread_execution_reports"."publication" = 'pending';--> statement-breakpoint
ALTER TABLE "thread_run_leases" ADD CONSTRAINT "thread_run_leases_phase_valid" CHECK ("thread_run_leases"."phase" IN ('generating','waiting','compacting'));--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_compaction_model_required" CHECK ("turns"."role" != 'compaction' OR "turns"."status" != 'complete' OR "turns"."compaction_model" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "thread_run_leases" ADD COLUMN "bound_turn_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;