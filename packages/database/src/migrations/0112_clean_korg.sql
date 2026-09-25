ALTER TABLE "thread_execution_reports" ADD COLUMN "terminal_assistant_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_run_leases" ADD COLUMN "adopted_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_terminal_assistant_turn_id_turns_id_fk" FOREIGN KEY ("terminal_assistant_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (pre-release schema; no production users or data)
