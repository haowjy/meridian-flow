-- migration: no-transaction
-- B1a: retire the index over document_edits.action_id on its own, concurrently, so 0053 can drop the
-- columns without a table-wide index teardown under its exclusive lock. Re-runnable.
DROP INDEX CONCURRENTLY IF EXISTS "document_edits_action_idx";
