ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_intent_valid";--> statement-breakpoint
-- Map legacy intent values to the renamed vocabulary before re-adding the narrowed check (pre-release schema; no production users or data).
UPDATE "thread_inbox_messages" SET "intent" = CASE "intent" WHEN 'steer' THEN 'message' WHEN 'system' THEN 'notice' END WHERE "intent" IN ('steer','system');--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_intent_valid" CHECK ("thread_inbox_messages"."intent" IN ('message','notice'));
