CREATE TABLE "user_recent_documents" (
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_recent_documents_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "user_recent_documents" ADD CONSTRAINT "user_recent_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new table is empty when this constraint is added)--> statement-breakpoint
ALTER TABLE "user_recent_documents" ADD CONSTRAINT "user_recent_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (new table is empty when this constraint is added)--> statement-breakpoint
CREATE INDEX "user_recent_documents_user_opened_idx" ON "user_recent_documents" USING btree ("user_id","opened_at" DESC NULLS LAST); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (new table is empty when this index is added)