ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_body_valid_v2" CHECK ((CASE WHEN "thread_inbox_messages"."intent" = 'control' THEN ("thread_inbox_messages"."body"->>'kind' IN ('compact','ask_resolved') OR ("thread_inbox_messages"."body"->>'kind' = 'write_mode' AND "thread_inbox_messages"."body"->>'mode' IN ('direct','draft'))) ELSE "thread_inbox_messages"."body"->>'kind' IN ('text','context','work_context_refresh') END) IS TRUE) NOT VALID;
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" VALIDATE CONSTRAINT "thread_inbox_messages_body_valid_v2";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_body_valid";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" RENAME CONSTRAINT "thread_inbox_messages_body_valid_v2" TO "thread_inbox_messages_body_valid";
