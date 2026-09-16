CREATE TABLE "agent_package_dependencies" (
	"package_revision_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dependency_revision_id" uuid NOT NULL,
	CONSTRAINT "agent_package_dependencies_package_revision_id_name_pk" PRIMARY KEY("package_revision_id","name")
);
--> statement-breakpoint
ALTER TABLE "thread_agent_bindings" ADD COLUMN "configuration" jsonb;
--> statement-breakpoint
-- Existing executable bindings required an explicit model and no loaded skills.
UPDATE "thread_agent_bindings" AS binding SET "configuration" = jsonb_build_object(
  'model', definition.definition->'metadata'->>'model',
  'skills', jsonb_build_object('load', '[]'::jsonb, 'available', '[]'::jsonb),
  'namedTargets', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('name', target.slug, 'definitionRevisionId', target.id) ORDER BY declared.ordinal)
    FROM jsonb_array_elements_text(COALESCE(definition.definition->'metadata'->'subagents', '[]'::jsonb)) WITH ORDINALITY AS declared(name, ordinal)
    JOIN agent_definition_revisions AS target ON target.package_revision_id = definition.package_revision_id AND target.slug = declared.name
  ), '[]'::jsonb)
) FROM "agent_definition_revisions" AS definition WHERE definition.id = binding.definition_revision_id;
--> statement-breakpoint
ALTER TABLE "thread_agent_bindings" ALTER COLUMN "configuration" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (pre-release bindings are backfilled in this migration; no production data)--> statement-breakpoint
ALTER TABLE "agent_package_dependencies" ADD CONSTRAINT "agent_package_dependencies_package_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (dependency table is created empty above)--> statement-breakpoint
ALTER TABLE "agent_package_dependencies" ADD CONSTRAINT "agent_package_dependencies_dependency_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("dependency_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (dependency table is created empty above)