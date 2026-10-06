CREATE TABLE "link_redirects" (
	"source_document_id" uuid NOT NULL,
	"href" text NOT NULL,
	"target_document_id" uuid,
	"intended_uri" text,
	"old_filename" text NOT NULL,
	"mover_user_id" uuid,
	"mover_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	CONSTRAINT "link_redirects_source_document_id_href_pk" PRIMARY KEY("source_document_id","href"),
	CONSTRAINT "link_redirects_target" CHECK (("link_redirects"."target_document_id" IS NULL) <> ("link_redirects"."intended_uri" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "link_redirects" ADD CONSTRAINT "link_redirects_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */
--> statement-breakpoint
ALTER TABLE "link_redirects" ADD CONSTRAINT "link_redirects_target_document_id_documents_id_fk" FOREIGN KEY ("target_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */
--> statement-breakpoint
CREATE INDEX "link_redirects_target_document" ON "link_redirects" USING btree ("target_document_id"); /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table created empty in this migration; no concurrent writes to block) */