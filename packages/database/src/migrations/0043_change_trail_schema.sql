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
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "change_count" integer;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "swept_change_count" integer;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "document_count" integer;--> statement-breakpoint
ALTER TABLE "change_trail_document_occurrences" ADD CONSTRAINT "change_trail_document_occurrences_trail_id_change_trail_shells_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."change_trail_shells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_journal_id_branch_write_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."branch_write_journal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_branch_id_document_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."document_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_trail_work_ready" ON "turn_trail_work" USING btree ("next_attempt_at") WHERE "turn_trail_work"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "turn_trail_work_owner" ON "turn_trail_work" USING btree ("thread_id","turn_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "event_journal_event_id_unique" ON "event_journal" USING btree (("payload"->>'eventId')) WHERE "event_journal"."payload"->>'eventId' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_counts_valid" CHECK (("change_trail_delivery_outbox"."event_kind" = 'settled' AND "change_trail_delivery_outbox"."change_count" IS NULL AND "change_trail_delivery_outbox"."swept_change_count" IS NULL AND "change_trail_delivery_outbox"."document_count" IS NULL) OR ("change_trail_delivery_outbox"."event_kind" = 'updated' AND "change_trail_delivery_outbox"."change_count" >= 0 AND "change_trail_delivery_outbox"."swept_change_count" >= 0 AND "change_trail_delivery_outbox"."swept_change_count" <= "change_trail_delivery_outbox"."change_count" AND "change_trail_delivery_outbox"."document_count" >= 0));--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD CONSTRAINT "change_trail_shells_state_counts_valid" CHECK ("change_trail_shells"."state" IN ('building', 'settling', 'settled') AND "change_trail_shells"."version" > 0 AND "change_trail_shells"."change_count" >= 0 AND "change_trail_shells"."swept_change_count" >= 0 AND "change_trail_shells"."swept_change_count" <= "change_trail_shells"."change_count" AND "change_trail_shells"."document_count" >= 0 AND (("change_trail_shells"."state" = 'settled') = ("change_trail_shells"."settled_at" IS NOT NULL)));