-- REQUIRES ALL WRITERS STOPPED: this release no longer inserts push_lineage, so an old instance's
-- Apply fails on the missing table for the length of a rolling deploy. The drop takes its 5 indexes.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DROP TABLE "push_lineage";
