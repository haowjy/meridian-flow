SET LOCAL lock_timeout = '5s';
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
ALTER TABLE "collab_staged_states" ADD CONSTRAINT "collab_staged_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
-- This table is created in this transaction; no concurrent writer can reach it.
CREATE INDEX "collab_staged_states_project_idx" ON "collab_staged_states" USING btree ("project_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY
--> statement-breakpoint
ALTER TABLE "collab_staged_states" VALIDATE CONSTRAINT "collab_staged_states_project_id_projects_id_fk";
