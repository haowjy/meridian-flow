-- migration: no-transaction
-- Extend immutable child reports without holding ACCESS EXCLUSIVE through validation.
SET lock_timeout = '2s';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_execution_reports'::regclass
      AND conname = 'thread_execution_reports_outcome_valid_v2'
  ) THEN
    ALTER TABLE thread_execution_reports ADD CONSTRAINT thread_execution_reports_outcome_valid_v2
      CHECK (outcome IS NULL OR outcome IN ('succeeded','asked','failed','cancelled')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_execution_reports'::regclass
      AND conname = 'thread_execution_reports_outcome_valid_v2'
      AND NOT convalidated
  ) THEN
    ALTER TABLE thread_execution_reports VALIDATE CONSTRAINT thread_execution_reports_outcome_valid_v2;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_execution_reports'::regclass
      AND conname = 'thread_execution_reports_outcome_valid_v2'
  ) THEN
    ALTER TABLE thread_execution_reports DROP CONSTRAINT IF EXISTS thread_execution_reports_outcome_valid;
    ALTER TABLE thread_execution_reports RENAME CONSTRAINT thread_execution_reports_outcome_valid_v2 TO thread_execution_reports_outcome_valid;
  END IF;
END $$;
--> statement-breakpoint
RESET lock_timeout;
