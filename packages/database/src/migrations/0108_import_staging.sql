SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "context_staged_documents" (
	"staging_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"parent_id" uuid,
	"area" text NOT NULL,
	"name" text NOT NULL,
	"extension" text NOT NULL,
	"filetype" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"origin" jsonb NOT NULL,
	"storage_url" text,
	"mime_type" text,
	"size_bytes" bigint NOT NULL,
	"ahead_mints" jsonb NOT NULL,
	CONSTRAINT "context_staged_documents_staging_id_id_pk" PRIMARY KEY("staging_id","id")
);
--> statement-breakpoint
CREATE TABLE "context_staged_folders" (
	"staging_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"parent_id" uuid,
	"area" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "context_staged_folders_staging_id_id_pk" PRIMARY KEY("staging_id","id")
);
--> statement-breakpoint
CREATE TABLE "collab_staged_states" (
	"staging_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"state" "bytea" NOT NULL,
	"state_vector" "bytea" NOT NULL,
	"attribution_manifest" jsonb NOT NULL,
	"markdown" text NOT NULL,
	CONSTRAINT "collab_staged_states_staging_id_document_id_pk" PRIMARY KEY("staging_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "context_staged_documents" ADD CONSTRAINT "context_staged_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "context_staged_folders" ADD CONSTRAINT "context_staged_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "collab_staged_states" ADD CONSTRAINT "collab_staged_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "context_staged_documents_project_idx" ON "context_staged_documents" USING btree ("project_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table created in this transaction)
--> statement-breakpoint
CREATE INDEX "context_staged_folders_project_idx" ON "context_staged_folders" USING btree ("project_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table created in this transaction)
--> statement-breakpoint
CREATE INDEX "collab_staged_states_project_idx" ON "collab_staged_states" USING btree ("project_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table created in this transaction)
--> statement-breakpoint
ALTER TABLE "context_staged_documents" VALIDATE CONSTRAINT "context_staged_documents_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "context_staged_folders" VALIDATE CONSTRAINT "context_staged_folders_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "collab_staged_states" VALIDATE CONSTRAINT "collab_staged_states_project_id_projects_id_fk";
