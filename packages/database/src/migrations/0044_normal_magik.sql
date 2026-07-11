CREATE TABLE "change_trail_document_occurrences" (
	"trail_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "change_trail_document_occurrences_trail_id_document_id_pk" PRIMARY KEY("trail_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "turn_trail_work" (
	"journal_id" bigint PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"branch_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turn_trail_work_state_valid" CHECK ("turn_trail_work"."state" IN ('pending', 'running', 'complete', 'no_op', 'exhausted'))
);
--> statement-breakpoint
ALTER TABLE "change_trail_document_occurrences" ADD CONSTRAINT "change_trail_document_occurrences_trail_id_change_trail_shells_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."change_trail_shells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_journal_id_branch_write_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."branch_write_journal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_branch_id_document_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."document_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_trail_work_ready" ON "turn_trail_work" USING btree ("next_attempt_at") WHERE "turn_trail_work"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "turn_trail_work_owner" ON "turn_trail_work" USING btree ("thread_id","turn_id","state");