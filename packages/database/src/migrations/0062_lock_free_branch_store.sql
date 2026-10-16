-- #919 drafts without locks, phase 1a: a branch is a checkpoint (`state`) plus a journal tail
-- (`branch_write_journal.id > checkpoint_seq`), fenced by `revision` instead of a compare of its
-- full bytes. Metadata-only adds (constant defaults); 0063 backfills `checkpoint_seq` and `frozen`.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL, ADD COLUMN "checkpoint_revision" bigint DEFAULT 0 NOT NULL, ADD COLUMN "checkpoint_seq" bigint DEFAULT 0 NOT NULL, ADD COLUMN "frozen" boolean DEFAULT false NOT NULL;
