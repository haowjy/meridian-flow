CREATE TABLE "agent_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"logical_key" text NOT NULL,
	"selected_revision_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_sort_key" text NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_definition_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_revision_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_package_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coordinate" text NOT NULL,
	"schema_version" integer NOT NULL,
	"content_digest" text NOT NULL,
	"source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_agent_bindings" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"definition_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_catalog_entries" ADD CONSTRAINT "agent_catalog_entries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "agent_catalog_entries" ADD CONSTRAINT "agent_catalog_entries_selected_revision_id_agent_definition_revisions_id_fk" FOREIGN KEY ("selected_revision_id") REFERENCES "public"."agent_definition_revisions"("id") ON DELETE restrict ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "agent_definition_revisions" ADD CONSTRAINT "agent_definition_revisions_package_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "thread_agent_bindings" ADD CONSTRAINT "thread_agent_bindings_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "thread_agent_bindings" ADD CONSTRAINT "thread_agent_bindings_definition_revision_id_agent_definition_revisions_id_fk" FOREIGN KEY ("definition_revision_id") REFERENCES "public"."agent_definition_revisions"("id") ON DELETE restrict ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_catalog_entries_personal_key" ON "agent_catalog_entries" USING btree ("owner_user_id","logical_key") WHERE "agent_catalog_entries"."owner_user_id" IS NOT NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_catalog_entries_system_key" ON "agent_catalog_entries" USING btree ("logical_key") WHERE "agent_catalog_entries"."owner_user_id" IS NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
--> statement-breakpoint
CREATE INDEX "agent_catalog_entries_owner_name" ON "agent_catalog_entries" USING btree ("owner_user_id","name_sort_key","id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_definition_revisions_package_slug" ON "agent_definition_revisions" USING btree ("package_revision_id","slug"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_package_revisions_coordinate_digest" ON "agent_package_revisions" USING btree ("coordinate","content_digest"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
