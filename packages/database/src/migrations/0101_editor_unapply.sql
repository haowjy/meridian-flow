-- migration: no-transaction
-- A new effect table: its indexes scan no rows. Foreign-key locks on existing parent tables are bounded.
SET lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "apply_command_effects" (
	"command_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"group_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"draft_id" text NOT NULL,
	"live_update_seq" bigint,
	"base_before" jsonb NOT NULL,
	"base_after" jsonb NOT NULL,
	"unapplied_by" uuid,
	CONSTRAINT "apply_command_effects_command_id_ordinal_pk" PRIMARY KEY("command_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "apply_command_effects" ADD CONSTRAINT "apply_command_effects_command_id_branch_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."branch_commands"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "apply_command_effects" ADD CONSTRAINT "apply_command_effects_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "apply_command_effects" VALIDATE CONSTRAINT "apply_command_effects_command_id_branch_commands_id_fk";--> statement-breakpoint
ALTER TABLE "apply_command_effects" VALIDATE CONSTRAINT "apply_command_effects_document_id_documents_id_fk";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "apply_command_effects_group" ON "apply_command_effects" USING btree ("command_id","group_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "apply_command_effects_live_seq" ON "apply_command_effects" USING btree ("live_update_seq");--> statement-breakpoint
ALTER TABLE "branch_commands" ADD CONSTRAINT "branch_commands_kind_valid_v2" CHECK ("branch_commands"."kind" IN ('apply_click', 'unapply_click', 'apply_items', 'apply_changes', 'discard_items', 'discard_changes', 'discard_branch')) NOT VALID;--> statement-breakpoint
ALTER TABLE "branch_commands" VALIDATE CONSTRAINT "branch_commands_kind_valid_v2";--> statement-breakpoint
ALTER TABLE "branch_commands" DROP CONSTRAINT "branch_commands_kind_valid";--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "branch_commands_kind_valid_v2" TO "branch_commands_kind_valid";