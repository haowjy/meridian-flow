ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_provenance_kind_matches";--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_body_kind_matches";--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_provenance_valid";--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_body_valid";--> statement-breakpoint
DROP INDEX "thread_execution_reports_pending";--> statement-breakpoint
CREATE INDEX "thread_execution_reports_pending" ON "thread_execution_reports" USING btree ("assistant_turn_id") WHERE "thread_execution_reports"."publication" = 'pending'; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release recovery index rebuild; no deployed traffic)--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" DROP COLUMN "provenance_kind"; -- migration-lint: skip DROP_COLUMN (pre-release removal of redundant JSON kind copies; no readers remain)--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" DROP COLUMN "body_kind"; -- migration-lint: skip DROP_COLUMN (pre-release removal of redundant JSON kind copies; no readers remain)--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_provenance_valid" CHECK (("thread_inbox_messages"."provenance"->>'kind' IN ('writer','agent','child','system')) IS TRUE);--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_body_valid" CHECK (("thread_inbox_messages"."body"->>'kind' IN ('text','report','context')) IS TRUE);
