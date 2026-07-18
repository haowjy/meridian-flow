CREATE TABLE "project_user_working_sets" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recent_routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_thread_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_user_working_sets_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "working_set_sync_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_user_working_sets" ADD CONSTRAINT "project_user_working_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "project_user_working_sets" VALIDATE CONSTRAINT "project_user_working_sets_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_user_working_sets" ADD CONSTRAINT "project_user_working_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "project_user_working_sets" VALIDATE CONSTRAINT "project_user_working_sets_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "project_user_working_sets" ADD CONSTRAINT "project_user_working_sets_last_thread_id_threads_id_fk" FOREIGN KEY ("last_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "project_user_working_sets" VALIDATE CONSTRAINT "project_user_working_sets_last_thread_id_threads_id_fk";