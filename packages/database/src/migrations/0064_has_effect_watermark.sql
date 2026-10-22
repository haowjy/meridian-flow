-- #939 phase 4: a branch's `has_effect` is a projection of its content, written after the append
-- commits. `has_effect_revision` is the revision it was judged at; `< revision` is stale and the
-- projection sweep re-judges it. A constant default is a catalog-only change (no rewrite), and
-- `-1` is the stale sentinel: every existing row, revision 0 included, is re-judged once.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "has_effect_revision" bigint DEFAULT -1 NOT NULL;
