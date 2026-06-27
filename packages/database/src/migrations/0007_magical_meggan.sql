CREATE TABLE "pending_undo_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"write_handle" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"uri" text NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_undo_notifications_direction_valid" CHECK ("pending_undo_notifications"."direction" IN ('undo', 'redo'))
);
--> statement-breakpoint
ALTER TABLE "pending_undo_notifications" ADD CONSTRAINT "pending_undo_notifications_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_undo_notifications" ADD CONSTRAINT "pending_undo_notifications_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_undo_notifications_thread" ON "pending_undo_notifications" USING btree ("thread_id");
