CREATE TABLE "agent_catalog_revisions" (
	"catalog_entry_id" uuid NOT NULL,
	"definition_revision_id" uuid NOT NULL,
	CONSTRAINT "agent_catalog_revisions_catalog_entry_id_definition_revision_id_pk" PRIMARY KEY("catalog_entry_id","definition_revision_id")
);
--> statement-breakpoint
ALTER TABLE "agent_catalog_revisions" ADD CONSTRAINT "agent_catalog_revisions_catalog_entry_id_agent_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."agent_catalog_entries"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "agent_catalog_revisions" ADD CONSTRAINT "agent_catalog_revisions_definition_revision_id_agent_definition_revisions_id_fk" FOREIGN KEY ("definition_revision_id") REFERENCES "public"."agent_definition_revisions"("id") ON DELETE restrict ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
