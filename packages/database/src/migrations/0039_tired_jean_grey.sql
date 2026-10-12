SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "change_trail_dirty_log" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "change_trail_dirty_log_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"thread_id" uuid NOT NULL,
	"turn_id" uuid
);
--> statement-breakpoint
DROP TABLE "turn_trail_work" CASCADE;--> statement-breakpoint
ALTER TABLE "change_trail_dirty_log" ADD CONSTRAINT "change_trail_dirty_log_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "change_trail_dirty_log" ADD CONSTRAINT "change_trail_dirty_log_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "change_trail_dirty_log_owner_seq" ON "change_trail_dirty_log" USING btree ("thread_id","turn_id","seq"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (relation created in this transaction; no producer can access it before commit)
--> statement-breakpoint
ALTER TABLE change_trail_dirty_log VALIDATE CONSTRAINT change_trail_dirty_log_thread_id_threads_id_fk;
--> statement-breakpoint
ALTER TABLE change_trail_dirty_log VALIDATE CONSTRAINT change_trail_dirty_log_turn_id_turns_id_fk;
