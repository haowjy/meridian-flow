CREATE TABLE "asks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL,
  "asking_turn_id" uuid NOT NULL,
  "execution_id" uuid NOT NULL,
  "tool_call_id" text NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "deadline_at" timestamp with time zone,
  "status" text DEFAULT 'pending' NOT NULL,
  "resolution" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "asks_turn_tool_call_unique" UNIQUE("asking_turn_id", "tool_call_id"),
  CONSTRAINT "asks_kind_valid" CHECK ("kind" IN ('question', 'permission')),
  CONSTRAINT "asks_status_valid" CHECK ("status" IN ('pending', 'open', 'answered', 'expired', 'cancelled')),
  CONSTRAINT "asks_resolution_coherent" CHECK (("status" IN ('pending', 'open') AND "resolution" IS NULL AND "resolved_at" IS NULL) OR ("status" IN ('answered', 'expired', 'cancelled') AND "resolution" IS NOT NULL AND "resolved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (asks is created empty in this migration)
--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_asking_turn_fk" FOREIGN KEY ("thread_id", "asking_turn_id") REFERENCES "public"."turns"("thread_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (asks is created empty in this migration)
--> statement-breakpoint
CREATE INDEX "asks_open_deadline" ON "asks" USING btree ("deadline_at", "id") WHERE "status" = 'open' AND "deadline_at" IS NOT NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table has no rows)
--> statement-breakpoint
CREATE INDEX "asks_thread_created" ON "asks" USING btree ("thread_id", "created_at", "id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table has no rows)
