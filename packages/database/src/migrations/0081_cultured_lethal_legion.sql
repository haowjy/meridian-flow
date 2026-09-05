CREATE TABLE "upload_intakes" (
	"project_id" uuid NOT NULL,
	"intake_id" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"work_id" uuid,
	"context_source_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"byte_digest" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"final_path" text NOT NULL,
	"object_key" text NOT NULL,
	"file_type" text NOT NULL,
	"canonical_uri" text NOT NULL,
	"location_revision" uuid NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"storage_url" text,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_intakes_project_intake_unique" UNIQUE("project_id","intake_id"),
	CONSTRAINT "upload_intakes_document_unique" UNIQUE("document_id"),
	CONSTRAINT "upload_intakes_state_valid" CHECK ("upload_intakes"."state" IN ('reserved', 'object_stored', 'finalized', 'deleted')),
	CONSTRAINT "upload_intakes_digest_valid" CHECK ("upload_intakes"."byte_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intakes_source_path_live" ON "upload_intakes" USING btree ("context_source_id",lower("final_path")) WHERE "upload_intakes"."state" <> 'deleted'; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
