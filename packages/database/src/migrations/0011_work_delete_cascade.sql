ALTER TABLE "threads" ADD COLUMN "deleted_by_work_id" uuid;--> statement-breakpoint
ALTER TABLE "context_sources" ADD COLUMN "deleted_by_work_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deleted_by_work_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "deleted_by_work_id" uuid;--> statement-breakpoint
ALTER TABLE "project_results" ADD COLUMN "deleted_by_work_id" uuid;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "deleted_by_work_id" uuid;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_deleted_by_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "context_sources" VALIDATE CONSTRAINT "context_sources_deleted_by_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_deleted_by_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "folders" VALIDATE CONSTRAINT "folders_deleted_by_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "project_results" VALIDATE CONSTRAINT "project_results_deleted_by_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "document_branches" VALIDATE CONSTRAINT "document_branches_deleted_by_work_id_works_id_fk";--> statement-breakpoint
CREATE INDEX "threads_deleted_by_work_idx" ON "threads" USING btree ("deleted_by_work_id") WHERE "threads"."deleted_by_work_id" IS NOT NULL; /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY */--> statement-breakpoint
CREATE INDEX "context_sources_deleted_by_work_idx" ON "context_sources" USING btree ("deleted_by_work_id") WHERE "context_sources"."deleted_by_work_id" IS NOT NULL; /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY */--> statement-breakpoint
CREATE INDEX "documents_deleted_by_work_idx" ON "documents" USING btree ("deleted_by_work_id") WHERE "documents"."deleted_by_work_id" IS NOT NULL; /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY */--> statement-breakpoint
CREATE INDEX "folders_deleted_by_work_idx" ON "folders" USING btree ("deleted_by_work_id") WHERE "folders"."deleted_by_work_id" IS NOT NULL; /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY */--> statement-breakpoint
CREATE INDEX "project_results_deleted_by_work_idx" ON "project_results" USING btree ("deleted_by_work_id") WHERE "project_results"."deleted_by_work_id" IS NOT NULL; /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY */--> statement-breakpoint
CREATE INDEX "document_branches_deleted_by_work_idx" ON "document_branches" USING btree ("deleted_by_work_id") WHERE "document_branches"."deleted_by_work_id" IS NOT NULL; /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY */
