CREATE TABLE "document_derivations" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"projection_generation" bigint NOT NULL,
	"projection_admission_sequence" bigint NOT NULL,
	"projection_location_version" bigint NOT NULL,
	"projection_extractor_version" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "location_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_derivations" ADD CONSTRAINT "document_derivations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */