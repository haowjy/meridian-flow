-- migration: no-transaction
-- REQUIRES ALL WRITERS STOPPED (old and new release): the old release writes folders.document_alias
-- and the new one does not, so either release fails on folder writes while the other's schema is live.
-- See packages/database/.context/CONTEXT.md.
-- Folders and documents clash by literal rendered filename; the folder document alias is retired.
DROP INDEX CONCURRENTLY IF EXISTS "folders_context_parent_alias_active";
--> statement-breakpoint
BEGIN;
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "folders" DROP COLUMN IF EXISTS "document_alias"; -- migration-lint: skip DROP_COLUMN (the alias was derived from name and no reader remains; the old release is stopped)
--> statement-breakpoint
COMMIT;
