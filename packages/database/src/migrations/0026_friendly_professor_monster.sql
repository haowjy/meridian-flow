CREATE TABLE "document_links" (
	"source_document_id" uuid NOT NULL,
	"href" text NOT NULL,
	"target_project_id" uuid,
	"target_key" text,
	"occurrences" integer NOT NULL,
	CONSTRAINT "document_links_source_document_id_href_pk" PRIMARY KEY("source_document_id","href")
);
--> statement-breakpoint
ALTER TABLE "document_derivations" ADD COLUMN "links_generation" bigint;--> statement-breakpoint
ALTER TABLE "document_derivations" ADD COLUMN "links_admission_sequence" bigint;--> statement-breakpoint
ALTER TABLE "document_derivations" ADD COLUMN "links_location_version" bigint;--> statement-breakpoint
ALTER TABLE "document_derivations" ADD COLUMN "links_extractor_version" integer;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */--> statement-breakpoint
CREATE INDEX "document_links_target_project" ON "document_links" USING btree ("target_project_id"); /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table created empty in this migration; nothing to scan) */--> statement-breakpoint
CREATE INDEX "document_links_target_key" ON "document_links" USING hash ("target_key"); /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table created empty in this migration; nothing to scan) */
