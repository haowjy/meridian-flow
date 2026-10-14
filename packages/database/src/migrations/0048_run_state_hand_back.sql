-- Run state, S2 and S3. Every statement is metadata-only or touches a new table: nullable columns
-- without defaults, and constraints added NOT VALID. 0049 validates them and builds the index.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
-- One row per hand-back request (Stop, the queue's x, Cancel queue): its stored decision, replayed by
-- request id.
CREATE TABLE "thread_hand_backs" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"handed_back" uuid[] NOT NULL,
	"answered" uuid[] NOT NULL,
	"gone" uuid[] NOT NULL,
	"cancelled_execution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Nullable, no default: metadata-only. The hand-back request that took this message out of the chat.
ALTER TABLE "thread_inbox_messages" ADD COLUMN "handed_back_by" uuid;
--> statement-breakpoint
-- Nullable, no default: metadata-only. Admissions recorded before this have no version; their replay
-- answers null and the client adds no intent for them.
ALTER TABLE "user_turn_admissions" ADD COLUMN "run_state_version" text;
--> statement-breakpoint
ALTER TABLE "thread_hand_backs" ADD CONSTRAINT "thread_hand_backs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_handed_back_by_fk" FOREIGN KEY ("handed_back_by") REFERENCES "public"."thread_hand_backs"("request_id") ON DELETE no action ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_hand_back" CHECK ("thread_inbox_messages"."handed_back_by" IS NULL OR ("thread_inbox_messages"."delivered_at" IS NOT NULL AND "thread_inbox_messages"."delivered_by_turn_id" IS NULL AND "thread_inbox_messages"."intent" = 'message')) NOT VALID;
