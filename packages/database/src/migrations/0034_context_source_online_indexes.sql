-- migration: no-transaction
-- The rollout fence (0032) excludes lineage rows throughout this swap; for all
-- existing rows the old project predicate and the new predicate therefore agree.
SET lock_timeout = '2s';
--> statement-breakpoint
-- Every statement is separate: a multi-statement simple query is transactional.
DROP INDEX CONCURRENTLY IF EXISTS context_sources_lineage_slug;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY context_sources_lineage_slug ON context_sources USING btree (root_thread_id, slug) WHERE root_thread_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS context_sources_project_slug_next;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY context_sources_project_slug_next ON context_sources USING btree (project_id, slug) WHERE work_id IS NULL AND root_thread_id IS NULL AND deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS context_sources_project_slug;
--> statement-breakpoint
ALTER INDEX context_sources_project_slug_next RENAME TO context_sources_project_slug;
--> statement-breakpoint
ALTER TABLE context_sources VALIDATE CONSTRAINT context_sources_exactly_one_scope;
--> statement-breakpoint
ALTER TABLE context_sources VALIDATE CONSTRAINT context_sources_scope_valid;
--> statement-breakpoint
ALTER TABLE context_sources VALIDATE CONSTRAINT context_sources_scope_work_fk;
--> statement-breakpoint
ALTER TABLE context_sources DROP CONSTRAINT IF EXISTS context_sources_lineage_rollout_fence;
--> statement-breakpoint
RESET lock_timeout;
