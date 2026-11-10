-- REQUIRES ALL WRITERS STOPPED: this release no longer inserts push_lineage, so an old instance's
-- Apply fails on the missing table for the length of a rolling deploy. The drop takes its 5 indexes.
-- It also drops the unused connector columns on context_sources: an old instance's source inserts
-- name adapter_type and fail for the same overlap.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DROP TABLE "push_lineage";
--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_adapter_type_valid";
--> statement-breakpoint
ALTER TABLE "context_sources" DROP COLUMN "adapter_type", DROP COLUMN "adapter_config", DROP COLUMN "sync_state", DROP COLUMN "is_primary";
