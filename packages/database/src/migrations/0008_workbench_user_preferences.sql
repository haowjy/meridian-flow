CREATE TABLE IF NOT EXISTS "workbench_user_preferences" (
  "user_id" uuid NOT NULL,
  "workbench_id" uuid NOT NULL,
  "thread_group_by" text DEFAULT 'work' NOT NULL,
  "pinned_thread_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "default_agent_slug" text,
  "auto_resume_enabled" boolean DEFAULT true NOT NULL,
  "auto_resume_timeout_ms" integer DEFAULT 270000 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workbench_user_preferences_pk" PRIMARY KEY("user_id","workbench_id"),
  CONSTRAINT "workbench_user_preferences_thread_group_by_check" CHECK ("thread_group_by" IN ('work', 'date', 'flat')),
  CONSTRAINT "workbench_user_preferences_auto_resume_timeout_check" CHECK ("auto_resume_timeout_ms" > 0)
);

ALTER TABLE "workbench_user_preferences" ADD CONSTRAINT "workbench_user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workbench_user_preferences" ADD CONSTRAINT "workbench_user_preferences_workbench_id_projects_id_fk" FOREIGN KEY ("workbench_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
