-- migration: no-transaction
-- Add the internal continuation kind without holding ACCESS EXCLUSIVE through validation.
SET lock_timeout = '2s';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_inbox_messages'::regclass
      AND conname = 'thread_inbox_messages_body_valid'
      AND pg_get_constraintdef(oid) LIKE '%ask_resolved%'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_inbox_messages'::regclass
      AND conname = 'thread_inbox_messages_body_valid_v2'
  ) THEN
    ALTER TABLE thread_inbox_messages ADD CONSTRAINT thread_inbox_messages_body_valid_v2 CHECK ((CASE WHEN intent = 'control' THEN (body->>'kind' IN ('compact','ask_resolved') OR (body->>'kind' = 'write_mode' AND body->>'mode' IN ('direct','draft'))) ELSE body->>'kind' IN ('text','context','work_context_refresh') END) IS TRUE) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_inbox_messages'::regclass
      AND conname = 'thread_inbox_messages_body_valid_v2'
      AND NOT convalidated
  ) THEN
    ALTER TABLE thread_inbox_messages VALIDATE CONSTRAINT thread_inbox_messages_body_valid_v2;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_inbox_messages'::regclass
      AND conname = 'thread_inbox_messages_body_valid_v2'
  ) THEN
    ALTER TABLE thread_inbox_messages DROP CONSTRAINT IF EXISTS thread_inbox_messages_body_valid;
    ALTER TABLE thread_inbox_messages RENAME CONSTRAINT thread_inbox_messages_body_valid_v2 TO thread_inbox_messages_body_valid;
  END IF;
END $$;
--> statement-breakpoint
RESET lock_timeout;
