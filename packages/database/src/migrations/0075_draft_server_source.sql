-- migration: no-transaction
-- Replacing the check is atomic; validation scans only after its DDL lock is released.
SET lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "draft_write_journal"
  DROP CONSTRAINT IF EXISTS "draft_write_journal_source_valid",
  ADD CONSTRAINT "draft_write_journal_source_valid"
    CHECK ("source" IN ('agent', 'writer', 'server')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "draft_write_journal" VALIDATE CONSTRAINT "draft_write_journal_source_valid";
--> statement-breakpoint
ALTER TABLE "branch_commands"
  DROP CONSTRAINT IF EXISTS "branch_commands_kind_valid",
  ADD CONSTRAINT "branch_commands_kind_valid"
    CHECK ("kind" IN ('apply_click', 'apply_items', 'apply_changes', 'discard_items', 'discard_changes', 'discard_branch')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_commands" VALIDATE CONSTRAINT "branch_commands_kind_valid";
--> statement-breakpoint
RESET lock_timeout;
