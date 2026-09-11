CREATE TABLE "document_previous_locations" (
	"context_source_id" uuid NOT NULL,
	"path" text NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_previous_locations" ADD CONSTRAINT "document_previous_locations_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty history table)
--> statement-breakpoint
ALTER TABLE "document_previous_locations" ADD CONSTRAINT "document_previous_locations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty history table)
--> statement-breakpoint
CREATE INDEX "document_previous_locations_path" ON "document_previous_locations" USING hash ("path"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new empty history table)
--> statement-breakpoint
CREATE INDEX "document_previous_locations_source" ON "document_previous_locations" USING btree ("context_source_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new empty history table)
--> statement-breakpoint
CREATE INDEX "document_previous_locations_document" ON "document_previous_locations" USING btree ("document_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new empty history table)
