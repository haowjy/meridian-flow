DELETE FROM "documents" WHERE "kind" = 'manifest';--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_kind_valid";--> statement-breakpoint
DROP INDEX "documents_manifest_context_active";--> statement-breakpoint
DROP INDEX "documents_context_folder_name_live";--> statement-breakpoint
DROP INDEX "documents_context_root_name_live";--> statement-breakpoint
DROP INDEX "documents_context_images";--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_folder_name_live" ON "documents" USING btree ("context_source_id","folder_id","name","extension") WHERE "documents"."deleted_at" IS NULL AND NOT "documents"."hidden";--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_root_name_live" ON "documents" USING btree ("context_source_id","name","extension") WHERE "documents"."folder_id" IS NULL AND "documents"."deleted_at" IS NULL AND NOT "documents"."hidden";--> statement-breakpoint
CREATE INDEX "documents_context_images" ON "documents" USING btree ("context_source_id") WHERE "documents"."file_type" = 'image';--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "kind";
