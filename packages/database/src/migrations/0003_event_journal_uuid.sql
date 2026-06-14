DROP INDEX "event_journal_thread_id";--> statement-breakpoint
ALTER TABLE "event_journal" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "event_journal" ALTER COLUMN "id" SET DATA TYPE uuid USING gen_random_uuid();--> statement-breakpoint
ALTER TABLE "event_journal" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
DROP SEQUENCE IF EXISTS "event_journal_id_seq";--> statement-breakpoint
CREATE INDEX "event_journal_thread_id" ON "event_journal" USING btree ("thread_id","created_at");
