-- migration: no-transaction
-- migration: code 0130_ordered_folders.ts sha256:87550de418ceea94c67a1d91cd7c8aeed63d22e3f9258d172a386afc7bae768d
-- REQUIRES ALL WRITERS STOPPED (old and new release): the old release reads and writes the order policy
-- columns and leaves new rows unranked, so either release breaks while the other's schema is live.
-- See packages/database/.context/CONTEXT.md.
-- The code half ranked every visible child; the policy it was ranked by is retired here.
BEGIN;
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
-- The code half wrote ranks into the tables but not into the stored catalog a browser resumes from; its cached
-- entries hold rank null for the formerly name-ordered parents and would show them in id order. A new generation
-- makes every old cursor read "reset required" and take a fresh snapshot built from the live tables.
UPDATE "context_catalog_scope_heads" SET "generation" = gen_random_uuid(), "updated_at" = now(); -- migration-lint: skip UPDATE_WITHOUT_WHERE (every catalog scope must fence its pre-migration replay cursor)
--> statement-breakpoint
ALTER TABLE "branch_tree_parent_orders" DROP COLUMN IF EXISTS "order_policy"; -- migration-lint: skip DROP_COLUMN (every row held "manual", which a row's presence now says; the old release is stopped)
--> statement-breakpoint
ALTER TABLE "context_sources" DROP COLUMN IF EXISTS "order_policy"; -- migration-lint: skip DROP_COLUMN (the code half ranked every child by it; no reader remains and the old release is stopped)
--> statement-breakpoint
ALTER TABLE "folders" DROP COLUMN IF EXISTS "order_policy"; -- migration-lint: skip DROP_COLUMN (the code half ranked every child by it; no reader remains and the old release is stopped)
--> statement-breakpoint
COMMIT;
