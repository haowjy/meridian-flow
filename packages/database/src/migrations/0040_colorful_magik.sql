SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "document_edit_parts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"edit_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"update" "bytea" NOT NULL,
	"effect" jsonb NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frontier" jsonb NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" jsonb NOT NULL,
	"placement" jsonb NOT NULL,
	CONSTRAINT "document_edit_parts_ordinal_valid" CHECK ("document_edit_parts"."ordinal" >= 0),
	CONSTRAINT "document_edit_parts_origin_valid" CHECK ("document_edit_parts"."origin"->>'kind' IN ('pending','live')),
	CONSTRAINT "document_edit_parts_placement_valid" CHECK ("document_edit_parts"."placement"->>'kind' IN ('pending','live','discarded','retired'))
);
--> statement-breakpoint
CREATE TABLE "document_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"thread_id" uuid,
	"turn_id" uuid,
	"response_id" text,
	"edit_scope_id" text,
	"actor" text NOT NULL,
	"actor_user_id" uuid,
	"w_id" integer,
	"kind" text NOT NULL,
	"action_id" uuid,
	"consumes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_edits_actor_valid" CHECK ("document_edits"."actor" IN ('agent','human','system')),
	CONSTRAINT "document_edits_kind_valid" CHECK ("document_edits"."kind" IN ('write','undo','redo','revert','rollback'))
);
--> statement-breakpoint
CREATE TABLE "change_trail_dirty_log" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "change_trail_dirty_log_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"thread_id" uuid NOT NULL,
	"turn_id" uuid
);
--> statement-breakpoint
ALTER TABLE "turn_trail_work" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "turn_trail_work" CASCADE;--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "document_yjs_reversal_ops" CASCADE;--> statement-breakpoint
DROP TABLE "document_yjs_reversals" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP CONSTRAINT "agent_edit_mutations_status_valid";--> statement-breakpoint
ALTER TABLE "document_yjs_updates" DROP CONSTRAINT "document_yjs_updates_reversal_actor_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "agent_edit_mutations_document_thread_write_id"; -- migration-lint: skip DROP_INDEX_NOT_CONCURRENTLY (retired columns and their indexes are removed in the same bounded-lock transaction)
--> statement-breakpoint
DROP INDEX "agent_edit_mutations_thread_status"; -- migration-lint: skip DROP_INDEX_NOT_CONCURRENTLY (retired columns and their indexes are removed in the same bounded-lock transaction)
--> statement-breakpoint
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "has_effect" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "blocking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "live_cut" "bytea";--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD COLUMN "edit_id" uuid;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD COLUMN "edit_part_ordinal" integer;--> statement-breakpoint
ALTER TABLE "document_edit_parts" ADD CONSTRAINT "document_edit_parts_edit_id_document_edits_id_fk" FOREIGN KEY ("edit_id") REFERENCES "public"."document_edits"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "change_trail_dirty_log" ADD CONSTRAINT "change_trail_dirty_log_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "change_trail_dirty_log" ADD CONSTRAINT "change_trail_dirty_log_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "document_edit_parts_edit_ordinal" ON "document_edit_parts" USING btree ("edit_id","ordinal"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (relation created in this transaction; no writer can access it before commit)
--> statement-breakpoint
CREATE INDEX "document_edit_parts_pending_idx" ON "document_edit_parts" USING btree (("placement"->>'branchId'),("placement"->>'generation')) WHERE "document_edit_parts"."placement"->>'kind' = 'pending'; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (relation created in this transaction; no writer can access it before commit)
--> statement-breakpoint
CREATE INDEX "document_edits_document_idx" ON "document_edits" USING btree ("document_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (relation created in this transaction; no writer can access it before commit)
--> statement-breakpoint
CREATE INDEX "document_edits_turn_idx" ON "document_edits" USING btree ("turn_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (relation created in this transaction; no writer can access it before commit)
--> statement-breakpoint
CREATE INDEX "document_edits_action_idx" ON "document_edits" USING btree ("action_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (relation created in this transaction; no writer can access it before commit)
--> statement-breakpoint
CREATE INDEX "change_trail_dirty_log_owner_seq" ON "change_trail_dirty_log" USING btree ("thread_id","turn_id","seq"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (relation created in this transaction; no writer can access it before commit)
--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_edit_id_document_edits_id_fk" FOREIGN KEY ("edit_id") REFERENCES "public"."document_edits"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN "undo_update_seq";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN "reversed_at";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN "reversed_by";--> statement-breakpoint
ALTER TABLE "document_yjs_updates" DROP COLUMN "reversal_actor_type";--> statement-breakpoint
ALTER TABLE "document_yjs_updates" DROP COLUMN "reversal_actor_user_id";
--> statement-breakpoint
ALTER TABLE "change_trail_dirty_log" VALIDATE CONSTRAINT "change_trail_dirty_log_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "change_trail_dirty_log" VALIDATE CONSTRAINT "change_trail_dirty_log_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "document_yjs_updates" VALIDATE CONSTRAINT "document_yjs_updates_edit_id_document_edits_id_fk";

--> statement-breakpoint
ALTER TABLE "document_edit_parts" VALIDATE CONSTRAINT "document_edit_parts_edit_id_document_edits_id_fk";
--> statement-breakpoint
ALTER TABLE "document_edits" VALIDATE CONSTRAINT "document_edits_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "document_edits" VALIDATE CONSTRAINT "document_edits_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "document_edits" VALIDATE CONSTRAINT "document_edits_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "document_edits" VALIDATE CONSTRAINT "document_edits_actor_user_id_users_id_fk";
