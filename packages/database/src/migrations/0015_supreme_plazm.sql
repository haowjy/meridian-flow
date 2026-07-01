ALTER TABLE "turns" DROP CONSTRAINT "turns_status_valid";--> statement-breakpoint
UPDATE "turns" SET "status" = 'waiting_interrupt' WHERE "status" = 'waiting_checkpoint';--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_status_valid" CHECK ("turns"."status" IN ('pending', 'streaming', 'waiting_interrupt', 'complete', 'cancelled', 'error'));