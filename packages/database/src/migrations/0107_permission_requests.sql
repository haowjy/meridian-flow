CREATE TABLE "project_action_grants" (
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_action_grants_project_action_unique" UNIQUE("project_id","action")
);
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "permission_command" jsonb;--> statement-breakpoint
ALTER TABLE "project_action_grants" ADD CONSTRAINT "project_action_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_permission_command_coherent" CHECK (("kind" = 'permission' AND "permission_command" IS NOT NULL) OR ("kind" = 'question' AND "permission_command" IS NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "asks" VALIDATE CONSTRAINT "asks_permission_command_coherent";
