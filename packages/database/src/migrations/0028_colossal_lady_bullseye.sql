ALTER TABLE "document_branches" ADD COLUMN "schema_version" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_branches" ALTER COLUMN "schema_version" DROP DEFAULT;
