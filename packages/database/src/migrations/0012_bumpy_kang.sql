ALTER TABLE "threads" DROP CONSTRAINT "threads_deleted_by_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_deleted_by_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_deleted_by_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT "folders_deleted_by_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "project_results" DROP CONSTRAINT "project_results_deleted_by_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "document_branches" DROP CONSTRAINT "document_branches_deleted_by_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;