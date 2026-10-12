SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "transport_journal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
