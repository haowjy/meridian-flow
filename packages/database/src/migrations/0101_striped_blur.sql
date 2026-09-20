CREATE TABLE "child_report_deliveries" (
	"report_id" uuid PRIMARY KEY NOT NULL,
	"parent_thread_id" uuid NOT NULL,
	"child_thread_id" uuid NOT NULL,
	"agent_slug" text NOT NULL,
	"description" text,
	"result" jsonb NOT NULL,
	"system_turn_id" uuid,
	"submission_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "child_report_deliveries_epoch_nonneg" CHECK ("child_report_deliveries"."submission_epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "child_report_deliveries" ADD CONSTRAINT "child_report_deliveries_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new table is empty when this constraint is added)--> statement-breakpoint
ALTER TABLE "child_report_deliveries" ADD CONSTRAINT "child_report_deliveries_child_thread_id_threads_id_fk" FOREIGN KEY ("child_thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new table is empty when this constraint is added)--> statement-breakpoint
CREATE INDEX "child_report_deliveries_parent_idx" ON "child_report_deliveries" USING btree ("parent_thread_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table is empty when this index is added)