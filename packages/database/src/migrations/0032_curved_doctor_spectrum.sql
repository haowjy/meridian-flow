CREATE TABLE "link_ahead_refs" (
	"ahead_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"scheme" text NOT NULL,
	"work_id" uuid,
	"path" text NOT NULL,
	"settled_document_id" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_settled_document_id_documents_id_fk" FOREIGN KEY ("settled_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "link_ahead_refs_unsettled" ON "link_ahead_refs" USING btree ("project_id","scheme","work_id","path") WHERE "link_ahead_refs"."settled_document_id" IS NULL;--> statement-breakpoint
CREATE INDEX "link_ahead_refs_settled_document" ON "link_ahead_refs" USING btree ("settled_document_id");