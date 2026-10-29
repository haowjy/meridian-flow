-- Permission requests: the stored command on a permission ask, and project-wide grants. The
-- coherence check is added NOT VALID here and validated in 0110, so its scan of `asks` holds no
-- ACCESS EXCLUSIVE lock. The grants table and its foreign key (which waits on `projects`) come
-- first, so `asks` is locked last and only for metadata changes.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "project_action_grants" (
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_action_grants_project_action_unique" UNIQUE("project_id","action")
);
--> statement-breakpoint
ALTER TABLE "project_action_grants" ADD CONSTRAINT "project_action_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (the child table is created empty above)
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "permission_command" jsonb;--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_permission_command_coherent" CHECK (("kind" = 'permission' AND "permission_command" IS NOT NULL) OR ("kind" = 'question' AND "permission_command" IS NULL)) NOT VALID;
