-- migration: no-transaction
-- Folders and documents clash by literal rendered filename; the folder document alias is retired.
DROP INDEX CONCURRENTLY IF EXISTS "folders_context_parent_alias_active";
--> statement-breakpoint
ALTER TABLE "folders" DROP COLUMN IF EXISTS "document_alias"; -- migration-lint: skip DROP_COLUMN (catalog-only drop; the only reader was the dropped index, and every reader in code is removed in this change)
