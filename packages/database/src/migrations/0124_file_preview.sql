ALTER TABLE "documents" ADD COLUMN "has_preview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "context_staged_documents" ADD COLUMN "has_preview" boolean DEFAULT false NOT NULL;