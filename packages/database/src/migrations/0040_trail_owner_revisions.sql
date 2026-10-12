-- Owner invalidation is part of the command transaction, never a worker hint.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DROP TRIGGER enlist_turn_trail_work ON branch_write_journal;
--> statement-breakpoint
DROP TRIGGER complete_turn_trail_work ON branch_write_journal;
--> statement-breakpoint
DROP FUNCTION enlist_turn_trail_work();
--> statement-breakpoint
DROP FUNCTION complete_turn_trail_work();
--> statement-breakpoint
-- Reconstruct dirty owners from authoritative history.
UPDATE turns SET trail_dirty_revision = 1
WHERE (role = 'assistant' AND status IN ('complete', 'cancelled', 'error'))
  OR EXISTS (SELECT 1 FROM branch_write_journal journal WHERE journal.turn_id = turns.id)
  OR EXISTS (SELECT 1 FROM change_trail_shells shell WHERE shell.turn_id = turns.id);
--> statement-breakpoint
UPDATE threads SET trail_dirty_revision = 1
WHERE EXISTS (SELECT 1 FROM turns WHERE turns.thread_id = threads.id AND turns.trail_dirty_revision > 0)
  OR EXISTS (SELECT 1 FROM change_trail_shells shell WHERE shell.thread_id = threads.id);
