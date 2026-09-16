CREATE TABLE "agent_package_installation_history" (
	"installation_id" uuid NOT NULL,
	"package_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_package_installation_history_installation_id_package_revision_id_pk" PRIMARY KEY("installation_id","package_revision_id")
);
--> statement-breakpoint
CREATE TABLE "agent_package_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"coordinate" text NOT NULL,
	"current_revision_id" uuid NOT NULL,
	"upstream_revision_id" uuid NOT NULL,
	"origin" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_package_installation_history" ADD CONSTRAINT "agent_package_installation_history_installation_id_agent_package_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_package_installations"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty management table)--> statement-breakpoint
ALTER TABLE "agent_package_installation_history" ADD CONSTRAINT "agent_package_installation_history_package_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty management table)--> statement-breakpoint
ALTER TABLE "agent_package_installations" ADD CONSTRAINT "agent_package_installations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty management table)--> statement-breakpoint
ALTER TABLE "agent_package_installations" ADD CONSTRAINT "agent_package_installations_current_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty management table)--> statement-breakpoint
ALTER TABLE "agent_package_installations" ADD CONSTRAINT "agent_package_installations_upstream_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("upstream_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new empty management table)--> statement-breakpoint
CREATE UNIQUE INDEX "agent_package_installations_personal_coordinate" ON "agent_package_installations" USING btree ("owner_user_id","coordinate") WHERE "agent_package_installations"."owner_user_id" IS NOT NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new empty management table)--> statement-breakpoint
CREATE UNIQUE INDEX "agent_package_installations_system_coordinate" ON "agent_package_installations" USING btree ("coordinate") WHERE "agent_package_installations"."owner_user_id" IS NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new empty management table)