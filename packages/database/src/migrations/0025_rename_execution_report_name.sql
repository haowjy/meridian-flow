ALTER TABLE "thread_execution_reports" RENAME COLUMN "description" TO "name"; -- migration-lint: skip RENAME_COLUMN (no deployed data; every read renamed in the same change)
