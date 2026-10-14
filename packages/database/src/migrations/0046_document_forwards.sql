-- Additive: a new table and its indexes; nothing existing is rewritten or locked.
CREATE TABLE "document_forwards" (
	"from_document_id" uuid PRIMARY KEY NOT NULL,
	"to_document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_forwards" ADD CONSTRAINT "document_forwards_to_document_id_documents_id_fk" FOREIGN KEY ("to_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_forwards" ADD CONSTRAINT "document_forwards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_forwards_to" ON "document_forwards" USING btree ("to_document_id");