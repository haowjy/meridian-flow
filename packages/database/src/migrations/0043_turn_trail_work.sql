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
  CONSTRAINT "turn_trail_work_state_valid" CHECK ("state" IN ('pending', 'running', 'complete', 'no_op', 'exhausted'))
);
--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_journal_id_branch_write_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."branch_write_journal"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_branch_id_document_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."document_branches"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "turn_trail_work_ready" ON "turn_trail_work" ("next_attempt_at") WHERE "state" = 'pending';
--> statement-breakpoint
CREATE INDEX "turn_trail_work_owner" ON "turn_trail_work" ("thread_id", "turn_id", "state");
--> statement-breakpoint
CREATE FUNCTION enlist_turn_trail_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thread_id IS NOT NULL AND NEW.turn_id IS NOT NULL THEN
    INSERT INTO turn_trail_work (journal_id, thread_id, turn_id, branch_id, state)
    VALUES (NEW.id, NEW.thread_id, NEW.turn_id, NEW.branch_id,
      CASE WHEN NEW.status IN ('pushed', 'discarded') THEN 'complete' ELSE 'pending' END);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER enlist_turn_trail_work AFTER INSERT ON branch_write_journal
FOR EACH ROW EXECUTE FUNCTION enlist_turn_trail_work();
--> statement-breakpoint
CREATE FUNCTION complete_turn_trail_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('pushed', 'discarded') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE turn_trail_work SET state = 'complete', updated_at = now(), last_error = NULL
    WHERE journal_id = NEW.id;
  ELSIF NEW.status = 'active' AND OLD.status = 'discarded' THEN
    UPDATE turn_trail_work SET state = 'pending', next_attempt_at = now(), updated_at = now()
    WHERE journal_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER complete_turn_trail_work AFTER UPDATE OF status ON branch_write_journal
FOR EACH ROW EXECUTE FUNCTION complete_turn_trail_work();
