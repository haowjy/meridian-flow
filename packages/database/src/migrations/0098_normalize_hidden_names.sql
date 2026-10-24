-- migration: no-transaction
-- migration: code 0098_normalize_hidden_names.ts sha256:a71386af825cd85fa2d71913aabe2832b2916408275a2507e4dc4e666cb035d1
CREATE INDEX CONCURRENTLY IF NOT EXISTS "folders_context_parent_alias_active"
  ON "folders" USING btree ("context_source_id", "parent_id", "document_alias")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_document_alias_present"
  CHECK ("document_alias" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "folders" VALIDATE CONSTRAINT "folders_document_alias_present";
--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "document_alias" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (the validated check proves every row was backfilled)
--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT "folders_document_alias_present";
