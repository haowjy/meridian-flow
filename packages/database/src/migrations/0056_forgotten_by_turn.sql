-- Forgetting a failed attempt (F1). One write-once fact per turn: the turn that retried the failed attempt or
-- moved the chat past it. Both statements are metadata-only (a nullable column without a default, and a
-- constraint added NOT VALID); 0057 validates the constraint and teaches the chat-activity projection.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "forgotten_by_turn_id" uuid;
--> statement-breakpoint
-- Same thread only: a chat forgets its own turns. Uses the existing turns_thread_id_id_unique.
ALTER TABLE "turns" ADD CONSTRAINT "turns_forgotten_by_fk" FOREIGN KEY ("thread_id","forgotten_by_turn_id") REFERENCES "public"."turns"("thread_id","id") ON DELETE no action ON UPDATE no action NOT VALID;
