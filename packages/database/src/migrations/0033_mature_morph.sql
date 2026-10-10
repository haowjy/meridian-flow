CREATE TABLE "document_markdown_projections" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "documents_markdown_projection_fts";--> statement-breakpoint
DROP INDEX "documents_markdown_projection_trgm";--> statement-breakpoint
ALTER TABLE "document_markdown_projections" ADD CONSTRAINT "document_markdown_projections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_markdown_projections_fts" ON "document_markdown_projections" USING gin (to_tsvector('simple', "markdown"));--> statement-breakpoint
CREATE INDEX "document_markdown_projections_trgm" ON "document_markdown_projections" USING gin ("markdown" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "markdown_projection";