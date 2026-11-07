-- Source uploads (a file dropped into a document) belong to no chat and no source until they
-- finalize, so the chat owner and the source become optional. Dropping NOT NULL is metadata only.
ALTER TABLE "upload_intakes" ALTER COLUMN "owner_thread_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_intakes" ALTER COLUMN "context_source_id" DROP NOT NULL;
