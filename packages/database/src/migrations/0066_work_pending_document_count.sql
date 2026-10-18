-- W47: a Work stores its pending-document count (the Works badge) instead of the Works snapshot
-- counting it at read time; a write bumps the Work's revision only when that count moved. A
-- constant default is a catalog-only change (no table rewrite). 0067 backfills it online.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "pending_document_count" integer DEFAULT 0 NOT NULL;
