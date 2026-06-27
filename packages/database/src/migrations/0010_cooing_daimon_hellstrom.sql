ALTER TABLE "pending_undo_notifications" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "pending_undo_notifications" ADD COLUMN "id" bigserial PRIMARY KEY NOT NULL;
