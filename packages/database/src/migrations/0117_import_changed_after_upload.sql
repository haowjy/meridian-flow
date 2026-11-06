SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "import_entries" ADD COLUMN "changed_after_upload" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- The fact used to share `reason` with the receive-time marks. Carry it over; the reason it replaced is unrecoverable.
UPDATE "import_entries" SET "changed_after_upload" = true, "reason" = NULL WHERE "reason" = 'changed_after_upload';
