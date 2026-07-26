ALTER TABLE "pending_notices" DROP CONSTRAINT "pending_notices_writer_document_id_documents_id_fk";
--> statement-breakpoint
DROP INDEX "pending_notices_writer";--> statement-breakpoint
ALTER TABLE "pending_notices" DROP COLUMN "writer_document_id";--> statement-breakpoint
ALTER TABLE "pending_notices" DROP COLUMN "writer_visible";--> statement-breakpoint
ALTER TABLE "pending_notices" DROP COLUMN "writer_consumed";