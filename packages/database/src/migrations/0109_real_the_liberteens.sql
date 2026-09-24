CREATE TABLE "thread_execution_reports" (
	"assistant_turn_id" uuid PRIMARY KEY NOT NULL,
	"child_thread_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"origin" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"caller_thread_id" uuid,
	"caller_turn_id" uuid,
	"tool_call_id" text,
	"card_block_id" uuid,
	"agent_slug" text,
	"description" text,
	"capture" jsonb,
	"capture_tool_call_id" text,
	"outcome" text,
	"reason" text,
	"source" text,
	"summary" text,
	"payload" jsonb,
	"artifacts" jsonb,
	"cost_millicredits" bigint,
	"terminal_at" timestamp with time zone,
	"publication" text DEFAULT 'none' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_execution_reports_origin_valid" CHECK ("thread_execution_reports"."origin" IN ('spawn','foreground_message','thread_run')),
	CONSTRAINT "thread_execution_reports_delivery_valid" CHECK ("thread_execution_reports"."delivery_mode" IN ('background_notification','direct','none')),
	CONSTRAINT "thread_execution_reports_origin_delivery_valid" CHECK (("thread_execution_reports"."origin" = 'spawn' AND "thread_execution_reports"."delivery_mode" IN ('background_notification','direct')) OR ("thread_execution_reports"."origin" = 'foreground_message' AND "thread_execution_reports"."delivery_mode" = 'direct') OR ("thread_execution_reports"."origin" = 'thread_run' AND "thread_execution_reports"."delivery_mode" = 'none')),
	CONSTRAINT "thread_execution_reports_capture_call_coherent" CHECK (("thread_execution_reports"."capture" IS NULL AND "thread_execution_reports"."capture_tool_call_id" IS NULL) OR ("thread_execution_reports"."capture" IS NOT NULL AND "thread_execution_reports"."capture_tool_call_id" IS NOT NULL)),
	CONSTRAINT "thread_execution_reports_outcome_valid" CHECK ("thread_execution_reports"."outcome" IS NULL OR "thread_execution_reports"."outcome" IN ('succeeded','failed','cancelled')),
	CONSTRAINT "thread_execution_reports_source_valid" CHECK ("thread_execution_reports"."source" IS NULL OR "thread_execution_reports"."source" IN ('return_result','final_assistant','empty')),
	CONSTRAINT "thread_execution_reports_publication_valid" CHECK ("thread_execution_reports"."publication" IN ('none','pending','published','skipped')),
	CONSTRAINT "thread_execution_reports_terminal_coherent" CHECK (("thread_execution_reports"."outcome" IS NULL AND "thread_execution_reports"."terminal_at" IS NULL) OR ("thread_execution_reports"."outcome" IS NOT NULL AND "thread_execution_reports"."source" IS NOT NULL AND "thread_execution_reports"."summary" IS NOT NULL AND "thread_execution_reports"."terminal_at" IS NOT NULL)),
	CONSTRAINT "thread_execution_reports_publication_timestamp_coherent" CHECK (("thread_execution_reports"."publication" IN ('none','pending') AND "thread_execution_reports"."published_at" IS NULL) OR ("thread_execution_reports"."publication" IN ('published','skipped') AND "thread_execution_reports"."published_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_assistant_turn_id_turns_id_fk" FOREIGN KEY ("assistant_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new report table is empty at FK creation)--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_child_thread_id_threads_id_fk" FOREIGN KEY ("child_thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new report table is empty at FK creation)--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_caller_thread_id_threads_id_fk" FOREIGN KEY ("caller_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new report table is empty at FK creation)--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_caller_turn_id_turns_id_fk" FOREIGN KEY ("caller_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new report table is empty at FK creation)--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_card_block_id_turn_blocks_id_fk" FOREIGN KEY ("card_block_id") REFERENCES "public"."turn_blocks"("id") ON DELETE set null ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new report table is empty at FK creation)--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_thread_id_id_unique" UNIQUE("thread_id","id");--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_child_turn_fk" FOREIGN KEY ("child_thread_id","assistant_turn_id") REFERENCES "public"."turns"("thread_id","id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new report table is empty at FK creation)--> statement-breakpoint
CREATE INDEX "thread_execution_reports_pending" ON "thread_execution_reports" USING btree ("created_at") WHERE "thread_execution_reports"."publication" = 'pending'; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new report table is empty at index creation)--> statement-breakpoint
