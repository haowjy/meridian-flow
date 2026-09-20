CREATE TABLE "thread_inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"intent" text NOT NULL,
	"provenance_kind" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"body_kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "thread_inbox_messages_idem_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "thread_inbox_messages_intent_valid" CHECK ("thread_inbox_messages"."intent" IN ('steer','system')),
	CONSTRAINT "thread_inbox_messages_provenance_valid" CHECK ("thread_inbox_messages"."provenance_kind" IN ('writer','agent','child','system')),
	CONSTRAINT "thread_inbox_messages_body_valid" CHECK ("thread_inbox_messages"."body_kind" IN ('text','report','context'))
);
--> statement-breakpoint
CREATE TABLE "thread_run_leases" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"holder_id" text NOT NULL,
	"phase" text DEFAULT 'generating' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "thread_run_leases_phase_valid" CHECK ("thread_run_leases"."phase" IN ('generating','waiting'))
);
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new table is empty when this constraint is added)--> statement-breakpoint
ALTER TABLE "thread_run_leases" ADD CONSTRAINT "thread_run_leases_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new table is empty when this constraint is added)--> statement-breakpoint
CREATE INDEX "thread_inbox_messages_pending" ON "thread_inbox_messages" USING btree ("thread_id","seq") WHERE "thread_inbox_messages"."delivered_at" IS NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table is empty when this index is added)--> statement-breakpoint
CREATE INDEX "thread_run_leases_expiry" ON "thread_run_leases" USING btree ("expires_at"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table is empty when this index is added)