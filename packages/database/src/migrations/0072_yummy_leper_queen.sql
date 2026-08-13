ALTER TABLE "thread_user_state" ADD COLUMN "is_favorite" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD COLUMN "manually_unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "thread_user_state_user_favorite_idx" ON "thread_user_state" USING btree ("user_id","thread_id") WHERE "thread_user_state"."is_favorite" = true;