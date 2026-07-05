CREATE TABLE "branch_write_journal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"branch_id" text NOT NULL,
	"generation" integer NOT NULL,
	"w_id" integer,
	"source" text DEFAULT 'agent' NOT NULL,
	"thread_id" uuid,
	"turn_id" uuid,
	"actor_user_id" uuid,
	"update_data" "bytea" NOT NULL,
	"update_meta" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_write_journal_source_valid" CHECK ("branch_write_journal"."source" IN ('agent', 'writer')),
	CONSTRAINT "branch_write_journal_status_valid" CHECK ("branch_write_journal"."status" IN ('active', 'pushed', 'discarded', 'rollback_pending'))
);
--> statement-breakpoint
CREATE TABLE "document_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"upstream_branch_id" text,
	"work_id" uuid,
	"thread_id" uuid,
	"push_policy" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"state" "bytea" NOT NULL,
	"state_vector" "bytea" NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_branches_kind_valid" CHECK ("document_branches"."kind" IN ('work_draft', 'thread_peer')),
	CONSTRAINT "document_branches_push_policy_valid" CHECK ("document_branches"."push_policy" IN ('manual', 'auto')),
	CONSTRAINT "document_branches_status_valid" CHECK ("document_branches"."status" IN ('active', 'closed')),
	CONSTRAINT "document_branches_owner_shape" CHECK (("document_branches"."kind" = 'work_draft' AND "document_branches"."work_id" IS NOT NULL AND "document_branches"."thread_id" IS NULL) OR ("document_branches"."kind" = 'thread_peer' AND "document_branches"."thread_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "push_lineage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"branch_id" text,
	"document_id" uuid NOT NULL,
	"push_kind" text NOT NULL,
	"journal_ids" bigint[] NOT NULL,
	"upstream_update_seq" bigint,
	"receipt_payload" jsonb,
	"pushed_by_user_id" uuid,
	"thread_id" uuid,
	"turn_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "kind" text DEFAULT 'manuscript' NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_branch_id_document_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."document_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_upstream_branch_id_document_branches_id_fk" FOREIGN KEY ("upstream_branch_id") REFERENCES "public"."document_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_branch_id_document_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."document_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_pushed_by_user_id_users_id_fk" FOREIGN KEY ("pushed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_write_journal_branch" ON "branch_write_journal" USING btree ("branch_id","generation","id");--> statement-breakpoint
CREATE INDEX "branch_write_journal_thread_turn" ON "branch_write_journal" USING btree ("branch_id","thread_id","turn_id");--> statement-breakpoint
CREATE INDEX "branch_write_journal_active" ON "branch_write_journal" USING btree ("branch_id","generation","status") WHERE "branch_write_journal"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "document_branches_active_work_draft" ON "document_branches" USING btree ("document_id","work_id") WHERE "document_branches"."kind" = 'work_draft' AND "document_branches"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "document_branches_active_thread_peer" ON "document_branches" USING btree ("document_id","thread_id") WHERE "document_branches"."kind" = 'thread_peer' AND "document_branches"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "push_lineage_idempotency" ON "push_lineage" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "push_lineage_document" ON "push_lineage" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "push_lineage_branch" ON "push_lineage" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "push_lineage_turn" ON "push_lineage" USING btree ("thread_id","turn_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kind_valid" CHECK ("documents"."kind" IN ('manuscript', 'manifest'));