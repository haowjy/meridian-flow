ALTER TABLE "work_context_delivery_obligations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "work_context_delivery_obligations" CASCADE;--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_body_valid";--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_body_valid" CHECK (("thread_inbox_messages"."body"->>'kind' IN ('text','context','work_context_refresh')) IS TRUE);