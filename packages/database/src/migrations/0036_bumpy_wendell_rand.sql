ALTER TABLE "documents" DROP CONSTRAINT "documents_kind_valid";--> statement-breakpoint
DROP INDEX "documents_context_folder_name_active";--> statement-breakpoint
DROP INDEX "documents_context_root_name_active";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "kind" SET DEFAULT 'content';--> statement-breakpoint
UPDATE "documents" SET "kind" = 'content' WHERE "kind" = 'manuscript';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_folder_name_active" ON "documents" USING btree ("context_source_id","folder_id","name","extension") WHERE "documents"."deleted_at" IS NULL AND "documents"."kind" = 'content';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_root_name_active" ON "documents" USING btree ("context_source_id","name","extension") WHERE "documents"."folder_id" IS NULL AND "documents"."deleted_at" IS NULL AND "documents"."kind" = 'content';--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kind_valid" CHECK ("documents"."kind" IN ('content', 'manifest'));
