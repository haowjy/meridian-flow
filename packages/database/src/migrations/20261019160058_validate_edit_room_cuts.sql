-- Separate validation avoids retaining ADD CHECK's ACCESS EXCLUSIVE lock during the scan.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_edits" VALIDATE CONSTRAINT "document_edits_cuts_presence";
