CREATE TABLE "user_turn_admissions" (
	"thread_id" uuid NOT NULL,
	"submission_id" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"fingerprint" text,
	"state" text NOT NULL,
	"rejection_code" text,
	"user_turn_id" uuid,
	"assistant_turn_id" uuid,
	"resume_after_seq" text,
	"snapshot_floor_next_seq" text,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_turn_admissions_thread_id_submission_id_pk" PRIMARY KEY("thread_id","submission_id"),
	CONSTRAINT "user_turn_admissions_state_valid" CHECK ("user_turn_admissions"."state" IN ('pending', 'accepted', 'rejected', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "user_turn_admissions" ADD CONSTRAINT "user_turn_admissions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
