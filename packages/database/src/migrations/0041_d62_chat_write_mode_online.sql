-- migration: no-transaction
-- Online half of 0040_d62_chat_write_mode: validate the CHECKs it added NOT VALID. Re-runnable.
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_ai_write_mode_valid";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" VALIDATE CONSTRAINT "thread_inbox_messages_body_valid";
