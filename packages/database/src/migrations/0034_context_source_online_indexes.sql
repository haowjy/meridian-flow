-- migration: no-transaction
-- Keep the old project guard until its permanent replacement is valid.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS context_sources_lineage_slug ON context_sources USING btree (root_thread_id, slug) WHERE root_thread_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS context_sources_project_scope_slug ON context_sources USING btree (project_id, slug) WHERE work_id IS NULL AND root_thread_id IS NULL AND deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE context_sources VALIDATE CONSTRAINT context_sources_exactly_one_scope;
--> statement-breakpoint
ALTER TABLE context_sources VALIDATE CONSTRAINT context_sources_scope_valid;
--> statement-breakpoint
ALTER TABLE context_sources VALIDATE CONSTRAINT context_sources_scope_work_fk;
--> statement-breakpoint
SET lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE context_sources DROP CONSTRAINT IF EXISTS context_sources_lineage_rollout_fence;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS context_sources_project_slug;
