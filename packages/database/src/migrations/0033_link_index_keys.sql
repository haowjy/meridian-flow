DROP TABLE "link_redirects" CASCADE;--> statement-breakpoint
DROP TABLE "document_links" CASCADE;--> statement-breakpoint
ALTER TABLE "document_branches" ALTER COLUMN "schema_version" SET DEFAULT 1000000;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ALTER COLUMN "schema_version" SET DEFAULT 1000000;--> statement-breakpoint
CREATE TABLE "document_links" (
	"source_document_id" uuid NOT NULL,
	"link_key" text NOT NULL,
	"target_document_id" uuid,
	"ahead_id" uuid,
	"address" text,
	"occurrences" integer NOT NULL,
	CONSTRAINT "document_links_source_document_id_link_key_pk" PRIMARY KEY("source_document_id","link_key")
);
--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table recreated empty in this migration; derived data, nothing to scan) */--> statement-breakpoint
CREATE INDEX "document_links_target_document" ON "document_links" USING btree ("target_document_id"); /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table recreated empty in this migration; nothing to scan) */--> statement-breakpoint
CREATE INDEX "document_links_ahead" ON "document_links" USING btree ("ahead_id"); /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table recreated empty in this migration; nothing to scan) */
