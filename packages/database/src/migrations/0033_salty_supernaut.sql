SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_exactly_one_scope";
--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_scope_valid";
--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_scope_work_fk";
--> statement-breakpoint
ALTER TABLE "context_sources" ADD COLUMN "root_thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_exactly_one_scope" CHECK (("context_sources"."scope" = 'project' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NULL) OR ("context_sources"."scope" = 'work' AND "context_sources"."project_id" IS NULL AND "context_sources"."work_id" IS NOT NULL AND "context_sources"."root_thread_id" IS NULL) OR ("context_sources"."scope" = 'lineage' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NOT NULL AND "context_sources"."slug" = 'scratch')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_scope_valid" CHECK ("context_sources"."scope" IN ('project', 'work', 'lineage')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_scope_work_fk" CHECK ("context_sources"."scope" <> 'work' OR "context_sources"."work_id" IS NOT NULL) NOT VALID;
