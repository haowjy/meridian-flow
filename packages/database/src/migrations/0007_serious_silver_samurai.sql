CREATE TABLE "document_yjs_draft_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"update_data" "bytea" NOT NULL,
	"actor_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_yjs_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"status" text NOT NULL,
	"last_actor_turn_id" uuid,
	"applied_at" timestamp with time zone,
	"applied_by_user_id" uuid,
	"applied_update_seq" bigint,
	"discarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_yjs_drafts_status_valid" CHECK ("document_yjs_drafts"."status" IN ('active', 'applied', 'discarded'))
);
--> statement-breakpoint
DROP INDEX "agent_edit_mutations_document_thread_write_id";--> statement-breakpoint
DROP INDEX "agent_edit_mutations_document_thread_w_id";--> statement-breakpoint
DROP INDEX "agent_edit_mutations_thread_status";--> statement-breakpoint
DROP INDEX "agent_edit_mutations_turn";--> statement-breakpoint
DROP INDEX "document_yjs_reversals_document_thread_write";--> statement-breakpoint
DROP INDEX "document_yjs_reversals_document_thread";--> statement-breakpoint
ALTER TABLE "agent_edit_sync_state" DROP CONSTRAINT "agent_edit_sync_state_document_id_thread_id_pk";--> statement-breakpoint
ALTER TABLE "agent_edit_wid_counters" DROP CONSTRAINT "agent_edit_wid_counters_document_id_thread_id_pk";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD COLUMN "scope_id" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_edit_sync_state" ADD COLUMN "scope_id" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_edit_wid_counters" ADD COLUMN "scope_id" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD COLUMN "scope_id" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_edit_sync_state" ADD CONSTRAINT "agent_edit_sync_state_document_id_thread_id_scope_id_pk" PRIMARY KEY("document_id","thread_id","scope_id");--> statement-breakpoint
ALTER TABLE "agent_edit_wid_counters" ADD CONSTRAINT "agent_edit_wid_counters_document_id_thread_id_scope_id_pk" PRIMARY KEY("document_id","thread_id","scope_id");--> statement-breakpoint
ALTER TABLE "document_yjs_draft_updates" ADD CONSTRAINT "document_yjs_draft_updates_draft_id_document_yjs_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."document_yjs_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_draft_updates" ADD CONSTRAINT "document_yjs_draft_updates_actor_turn_id_turns_id_fk" FOREIGN KEY ("actor_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD CONSTRAINT "document_yjs_drafts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD CONSTRAINT "document_yjs_drafts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD CONSTRAINT "document_yjs_drafts_last_actor_turn_id_turns_id_fk" FOREIGN KEY ("last_actor_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD CONSTRAINT "document_yjs_drafts_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_yjs_draft_updates_draft_id" ON "document_yjs_draft_updates" USING btree ("draft_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_drafts_active_document_thread" ON "document_yjs_drafts" USING btree ("document_id","thread_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_write_id" ON "agent_edit_mutations" USING btree ("document_id","thread_id","write_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_w_id" ON "agent_edit_mutations" USING btree ("document_id","thread_id","w_id","scope_id");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_thread_status" ON "agent_edit_mutations" USING btree ("document_id","thread_id","status","scope_id");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_turn" ON "agent_edit_mutations" USING btree ("document_id","thread_id","turn_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_reversals_document_thread_write" ON "document_yjs_reversals" USING btree ("document_id","thread_id","write_id","scope_id");--> statement-breakpoint
CREATE INDEX "document_yjs_reversals_document_thread" ON "document_yjs_reversals" USING btree ("document_id","thread_id","scope_id");