SET LOCAL lock_timeout = '2s';--> statement-breakpoint
DELETE FROM "change_trail_delivery_outbox" WHERE "delivered_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" DROP COLUMN "delivered_at";
