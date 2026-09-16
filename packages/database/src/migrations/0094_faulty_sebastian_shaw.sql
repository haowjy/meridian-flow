CREATE TABLE "project_agent_removals" (
	"project_id" uuid NOT NULL,
	"catalog_entry_id" uuid NOT NULL,
	CONSTRAINT "project_agent_removals_project_id_catalog_entry_id_pk" PRIMARY KEY("project_id","catalog_entry_id")
);
--> statement-breakpoint
ALTER TABLE "project_agent_removals" ADD CONSTRAINT "project_agent_removals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty table)
--> statement-breakpoint
ALTER TABLE "project_agent_removals" ADD CONSTRAINT "project_agent_removals_catalog_entry_id_agent_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."agent_catalog_entries"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty table)
