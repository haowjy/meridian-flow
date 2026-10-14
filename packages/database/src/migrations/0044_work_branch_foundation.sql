SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "document_markdown_projections" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_tree_changes" (
	"draft_id" uuid NOT NULL,
	"node_kind" text NOT NULL,
	"node_id" uuid NOT NULL,
	"created" boolean DEFAULT false NOT NULL,
	"created_thread_id" uuid,
	"created_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_tree_changes_draft_id_node_kind_node_id_pk" PRIMARY KEY("draft_id","node_kind","node_id"),
	CONSTRAINT "draft_tree_changes_node_kind_valid" CHECK ("draft_tree_changes"."node_kind" IN ('document', 'folder')),
	CONSTRAINT "draft_tree_changes_says_something" CHECK ("draft_tree_changes"."created")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin_thread_id" uuid,
	"origin_work_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "drafts_status_valid" CHECK ("drafts"."status" IN ('active', 'closed')),
	CONSTRAINT "drafts_closed_shape" CHECK (("drafts"."status" = 'closed') = ("drafts"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "branch_push_settlement_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"claim_epoch" bigint DEFAULT 1 NOT NULL,
	"claim_kind" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error" text,
	"blocked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_push_settlement_batches_state_valid" CHECK ("branch_push_settlement_batches"."state" IN ('pending', 'blocked', 'completed', 'abandoned')),
	CONSTRAINT "branch_push_settlement_batches_terminal_shape" CHECK ((
        ("branch_push_settlement_batches"."state" = 'completed' AND "branch_push_settlement_batches"."completed_at" IS NOT NULL AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'blocked' AND "branch_push_settlement_batches"."blocked_at" IS NOT NULL AND "branch_push_settlement_batches"."last_error_code" IS NOT NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'abandoned' AND "branch_push_settlement_batches"."abandoned_at" IS NOT NULL AND "branch_push_settlement_batches"."last_error_code" IS NOT NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'pending' AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL)
      )),
	CONSTRAINT "branch_push_settlement_batches_claim_shape" CHECK ("branch_push_settlement_batches"."state" <> 'pending' OR (
        ("branch_push_settlement_batches"."claim_token" IS NOT NULL AND "branch_push_settlement_batches"."claim_kind" IS NOT NULL AND "branch_push_settlement_batches"."claimed_at" IS NOT NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NOT NULL)
        OR ("branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
      )),
	CONSTRAINT "branch_push_settlement_batches_claim_kind_valid" CHECK ("branch_push_settlement_batches"."claim_kind" IS NULL OR "branch_push_settlement_batches"."claim_kind" IN ('warm', 'recovery')),
	CONSTRAINT "branch_push_settlement_batches_counters_valid" CHECK ("branch_push_settlement_batches"."attempt_count" >= 0 AND "branch_push_settlement_batches"."claim_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "branch_push_settlement_holds" (
	"batch_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"document_id" uuid,
	"reason" jsonb NOT NULL,
	"decided_in" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_push_settlement_holds_batch_id_item_key_pk" PRIMARY KEY("batch_id","item_key"),
	CONSTRAINT "branch_push_settlement_holds_decided_in_valid" CHECK ("branch_push_settlement_holds"."decided_in" IN ('check', 'completion'))
);
--> statement-breakpoint
CREATE TABLE "branch_push_settlement_payloads" (
	"batch_id" uuid NOT NULL,
	"step_kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "branch_push_settlement_payloads_batch_id_step_kind_pk" PRIMARY KEY("batch_id","step_kind")
);
--> statement-breakpoint
CREATE TABLE "draft_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"work_id" uuid NOT NULL,
	"draft_id" uuid,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request_digest" text NOT NULL,
	"settlement_batch_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "draft_commands_kind_valid" CHECK ("draft_commands"."kind" IN ('apply_items', 'apply_changes', 'discard_items', 'discard_changes', 'discard_draft')),
	CONSTRAINT "draft_commands_state_valid" CHECK ("draft_commands"."state" IN ('pending', 'done')),
	CONSTRAINT "draft_commands_done_shape" CHECK (("draft_commands"."state" = 'done') = ("draft_commands"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
-- Drop the constraints on columns that leave or change meaning below. The two that return are
-- added NOT VALID at the end and validated in 0043_work_branch_foundation_online.
ALTER TABLE "documents" DROP CONSTRAINT "documents_kind_valid";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_state_valid";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_terminal_shape";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_claim_shape";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_claim_kind_valid";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_counters_valid";
--> statement-breakpoint
ALTER TABLE "document_branches" DROP CONSTRAINT "document_branches_owner_shape";
--> statement-breakpoint
ALTER TABLE "document_branches" DROP CONSTRAINT "document_branches_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "document_branches" DROP CONSTRAINT "document_branches_deleted_by_work_id_works_id_fk";
--> statement-breakpoint
-- Each document keeps its Markdown projection: copy it off the identity row before the column drops.
-- The manifest companion retires below and keeps none.
INSERT INTO "document_markdown_projections" ("document_id", "markdown", "updated_at")
SELECT "id", "markdown_projection", "updated_at" FROM "documents" WHERE "kind" <> 'manifest';
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "location_version" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "batch_id" uuid;
--> statement-breakpoint
-- Each existing push becomes a settlement batch of one with a deterministic id, carrying its claim
-- and terminal state, before the outbox columns that held that state drop in 0043.
-- settled_join_version is not copied: the completion transaction now owns the join fence.
INSERT INTO "branch_push_settlement_batches" ("id", "state", "claim_token", "claim_epoch", "claim_kind", "claimed_at", "lease_expires_at", "available_at", "attempt_count", "last_error_code", "last_error", "blocked_at", "completed_at", "created_at", "updated_at")
SELECT md5('branch-push-settlement:' || "push_id")::uuid, "state", "claim_token", "claim_epoch", "claim_kind", "claimed_at", "lease_expires_at", "available_at", "attempt_count", "last_error_code", "last_error", "blocked_at", "completed_at", "created_at", "updated_at"
FROM "branch_push_settlement_outbox";
--> statement-breakpoint
UPDATE "branch_push_settlement_outbox" SET "batch_id" = md5('branch-push-settlement:' || "push_id")::uuid
WHERE "batch_id" IS NULL;
--> statement-breakpoint
-- The ADD COLUMN above already holds this table's ACCESS EXCLUSIVE lock and the backfill rewrote every row.
ALTER TABLE "branch_push_settlement_outbox" ALTER COLUMN "batch_id" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (backfilled above under the same lock)
--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "draft_id" uuid;
--> statement-breakpoint
-- Soft delete no longer closes a Work's draft branches; restore returns the draft untouched. Reopen
-- the branches a Work delete closed, so restoring that Work still brings its pending edits back.
UPDATE "document_branches" b SET "status" = 'active'
WHERE b."deleted_by_work_id" IS NOT NULL AND b."kind" = 'work_draft' AND b."status" = 'closed'
  AND NOT EXISTS (
    SELECT 1 FROM "document_branches" a
    WHERE a."document_id" = b."document_id" AND a."work_id" = b."work_id"
      AND a."kind" = 'work_draft' AND a."status" = 'active'
  );
--> statement-breakpoint
-- Branches key by draft (decision 3): a Work with branches and no active draft gets one.
INSERT INTO "drafts" ("project_id", "origin_work_id", "created_by")
SELECT w."project_id", w."id", coalesce(w."created_by_user_id", p."user_id")
FROM "works" w JOIN "projects" p ON p."id" = w."project_id"
WHERE EXISTS (SELECT 1 FROM "document_branches" b WHERE b."work_id" = w."id")
  AND NOT EXISTS (
    SELECT 1 FROM "drafts" d WHERE d."origin_work_id" = w."id" AND d."status" = 'active'
  );
--> statement-breakpoint
UPDATE "document_branches" b SET "draft_id" = (
  SELECT d."id" FROM "drafts" d
  WHERE d."origin_work_id" = b."work_id" AND d."status" = 'active'
  ORDER BY d."created_at", d."id" LIMIT 1
) WHERE b."work_id" IS NOT NULL;
--> statement-breakpoint
-- A thread peer takes its upstream's draft.
UPDATE "document_branches" b SET "draft_id" = u."draft_id"
FROM "document_branches" u
WHERE b."draft_id" IS NULL AND u."id" = b."upstream_branch_id";
--> statement-breakpoint
-- A peer with neither a Work nor an upstream belongs to no draft; peers journal nothing. Its
-- pending parts retire first: an edit's part may name only a branch that still exists or "retired".
UPDATE "document_edit_parts" SET "placement" = '{"kind":"retired"}'::jsonb
WHERE "placement"->>'kind' = 'pending'
  AND "placement"->>'branchId' IN (SELECT "id" FROM "document_branches" WHERE "draft_id" IS NULL);
--> statement-breakpoint
DELETE FROM "document_branches" WHERE "draft_id" IS NULL;
--> statement-breakpoint
-- The ADD COLUMN above already holds this table's ACCESS EXCLUSIVE lock and the backfill rewrote every row.
ALTER TABLE "document_branches" ALTER COLUMN "draft_id" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (backfilled above under the same lock)
--> statement-breakpoint
-- A document a draft created was an empty live row the live manifest left out, and an active
-- `manifest_membership` row with `present` true on a Work's manifest draft is the evidence:
-- `main`'s live-manifest reconcile (`listProjectContentDocumentIds`) never published a document
-- that row names. Its other test, `draftSeedExclusions` (an empty document an active draft
-- holds), cannot tell a draft's create from an empty document the writer made live and a draft
-- then edited, which `main` showed live; it only kept reconcile from seeding the first. So the
-- membership row alone decides: each such document becomes a hidden identity before the
-- manifest and its journal retire. Folders stay as they are: `main` showed a draft's folders live.
UPDATE "documents" d SET "hidden" = true
WHERE d."kind" = 'content' AND EXISTS (
  SELECT 1 FROM "branch_write_journal" j
  WHERE j."status" = 'active'
    AND j."update_meta"->>'kind' = 'manifest_membership'
    AND j."update_meta"->>'present' = 'true'
    AND j."update_meta"->>'documentId' = d."id"::text
);
--> statement-breakpoint
-- Each draft still using a hidden document records its create (identity only; the document row is its location): one
-- whose latest active membership row keeps the document, or one with pending text on it (two
-- Works drafting one path share the identity). A draft whose membership `main` discarded does not.
INSERT INTO "draft_tree_changes" ("draft_id", "node_kind", "node_id", "created")
SELECT u."draft_id", 'document', d."id", true
FROM "documents" d
JOIN (
  SELECT m."draft_id", m."document_id" FROM (
    SELECT DISTINCT ON (b."draft_id", j."update_meta"->>'documentId')
      b."draft_id", j."update_meta"->>'documentId' AS "document_id",
      j."update_meta"->>'present' = 'true' AS "present"
    FROM "branch_write_journal" j JOIN "document_branches" b ON b."id" = j."branch_id"
    WHERE j."status" = 'active' AND j."update_meta"->>'kind' = 'manifest_membership'
    ORDER BY b."draft_id", j."update_meta"->>'documentId', j."id" DESC
  ) m WHERE m."present"
  UNION
  SELECT b."draft_id", b."document_id"::text FROM "document_branches" b
  WHERE b."kind" = 'work_draft' AND b."status" = 'active' AND EXISTS (
    SELECT 1 FROM "branch_write_journal" j
    WHERE j."branch_id" = b."id" AND j."status" IN ('active', 'rollback_pending')
  )
) u ON u."document_id" = d."id"::text
WHERE d."hidden";
--> statement-breakpoint
-- A hidden document no draft uses any more (`main` discarded its create) is tombstoned as a last
-- use's Discard leaves one: its storage goes and the row stays, marked deleted. Its immutable
-- edits stay; their pending parts retire with the branches.
WITH "unused" AS (
  SELECT d."id" FROM "documents" d
  WHERE d."hidden" AND d."deleted_at" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "draft_tree_changes" c WHERE c."node_kind" = 'document' AND c."node_id" = d."id"
  )
),
"retired_parts" AS (
  UPDATE "document_edit_parts" SET "placement" = '{"kind":"retired"}'::jsonb
  WHERE "placement"->>'kind' = 'pending' AND "placement"->>'branchId' IN (
    SELECT "id" FROM "document_branches" WHERE "document_id" IN (SELECT "id" FROM "unused")
  )
),
"heads" AS (DELETE FROM "document_yjs_heads" WHERE "document_id" IN (SELECT "id" FROM "unused")),
"checkpoints" AS (DELETE FROM "document_yjs_checkpoints" WHERE "document_id" IN (SELECT "id" FROM "unused")),
"updates" AS (DELETE FROM "document_yjs_updates" WHERE "document_id" IN (SELECT "id" FROM "unused")),
"branches" AS (DELETE FROM "document_branches" WHERE "document_id" IN (SELECT "id" FROM "unused")),
"derivations" AS (DELETE FROM "document_derivations" WHERE "document_id" IN (SELECT "id" FROM "unused")),
"projections" AS (DELETE FROM "document_markdown_projections" WHERE "document_id" IN (SELECT "id" FROM "unused")),
"links" AS (DELETE FROM "document_links" WHERE "source_document_id" IN (SELECT "id" FROM "unused"))
UPDATE "documents" d SET "deleted_at" = now(), "location_version" = d."location_version" + 1
WHERE d."id" IN (SELECT "id" FROM "unused");
--> statement-breakpoint
-- The live manifest companion retires with its branches and their membership journal: its
-- rows are derived from the tree, not writer data. Every remaining row is content, so
-- documents.kind can drop in 0043.
UPDATE "document_edit_parts" SET "placement" = '{"kind":"retired"}'::jsonb
WHERE "placement"->>'kind' = 'pending' AND "placement"->>'branchId' IN (
  SELECT b."id" FROM "document_branches" b JOIN "documents" d ON d."id" = b."document_id"
  WHERE d."kind" = 'manifest'
);
--> statement-breakpoint
DELETE FROM "documents" WHERE "kind" = 'manifest';
--> statement-breakpoint
-- A Work whose only branch was on the manifest drafted nothing writer-visible: its draft goes.
DELETE FROM "drafts" r
WHERE NOT EXISTS (SELECT 1 FROM "document_branches" b WHERE b."draft_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "draft_tree_changes" c WHERE c."draft_id" = r."id");
--> statement-breakpoint
-- The settlement state the dirty-signal trigger watched moves to the batch row. PostgreSQL records
-- a column trigger's dependency, so the outbox trigger goes now and 0043's DROP COLUMN needs no
-- CASCADE. The function gains a batch arm that signals the owners of every push of the batch;
-- the outbox keeps an insert-only trigger for a push staged into an existing batch.
DROP TRIGGER capture_change_trail_settlement ON branch_push_settlement_outbox;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_change_trail_signal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'document_edits' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners(ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'document_edit_parts' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners(ARRAY[NEW.edit_id]);
  ELSIF TG_TABLE_NAME = 'branch_write_journal' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'push_lineage' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'branch_push_settlement_outbox' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY[NEW.push_id]);
  ELSIF TG_TABLE_NAME = 'branch_push_settlement_batches' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY(
        SELECT o.push_id FROM branch_push_settlement_outbox o WHERE o.batch_id = NEW.id
      ));
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      VALUES (NEW.thread_id, NULL);
    IF NEW.role = 'assistant' OR EXISTS (
      SELECT 1 FROM change_trail_shells WHERE turn_id = NEW.id
    ) THEN
      INSERT INTO change_trail_dirty_log(thread_id, turn_id) VALUES (NEW.thread_id, NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_settlement AFTER INSERT ON branch_push_settlement_outbox
FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_batch AFTER INSERT OR UPDATE OF state ON branch_push_settlement_batches
FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
-- Foreign keys and checks are validated in 0043, outside this transaction.
--> statement-breakpoint
ALTER TABLE "document_markdown_projections" ADD CONSTRAINT "document_markdown_projections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "draft_tree_changes" ADD CONSTRAINT "draft_tree_changes_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "draft_tree_changes" ADD CONSTRAINT "draft_tree_changes_created_thread_id_threads_id_fk" FOREIGN KEY ("created_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "draft_tree_changes" ADD CONSTRAINT "draft_tree_changes_created_turn_id_turns_id_fk" FOREIGN KEY ("created_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "draft_commands" ADD CONSTRAINT "draft_commands_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "draft_commands" ADD CONSTRAINT "draft_commands_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "draft_commands" ADD CONSTRAINT "draft_commands_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "draft_commands" ADD CONSTRAINT "draft_commands_settlement_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("settlement_batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_origin_thread_id_threads_id_fk" FOREIGN KEY ("origin_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_origin_work_id_works_id_fk" FOREIGN KEY ("origin_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_holds" ADD CONSTRAINT "branch_push_settlement_holds_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_payloads" ADD CONSTRAINT "branch_push_settlement_payloads_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_counters_valid" CHECK ("branch_push_settlement_outbox"."join_version" >= 0 AND "branch_push_settlement_outbox"."classified_join_version" <= "branch_push_settlement_outbox"."join_version") NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_owner_shape" CHECK (("document_branches"."kind" = 'work_draft' AND "document_branches"."thread_id" IS NULL) OR ("document_branches"."kind" = 'thread_peer' AND "document_branches"."thread_id" IS NOT NULL)) NOT VALID;
