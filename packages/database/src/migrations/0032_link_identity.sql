-- Link identity: ahead-ref registry, shown-link ledger, and the identity-keyed link index.
-- document_links is derived data, so it is dropped and recreated rather than reshaped.
-- link_redirects is retired: links resolve by document identity, not by path history.
CREATE TABLE "thread_shown_links" (
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"address" text NOT NULL,
	"holder_uri" text NOT NULL,
	"view" text NOT NULL,
	"showing_digest" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "thread_shown_links_pk" PRIMARY KEY("thread_id","document_id","showing_digest","turn_id"),
	CONSTRAINT "thread_shown_links_digest_valid" CHECK ("thread_shown_links"."showing_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
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
DROP TABLE "link_redirects" CASCADE;--> statement-breakpoint
DROP TABLE "document_links" CASCADE;--> statement-breakpoint
CREATE TABLE "document_links" (
	"source_document_id" uuid NOT NULL,
	"link_key" text NOT NULL,
	"target_document_id" uuid,
	"ahead_id" uuid,
	"address" text,
	"occurrences" integer NOT NULL,
	CONSTRAINT "document_links_source_document_id_link_key_pk" PRIMARY KEY("source_document_id","link_key")
);
--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */--> statement-breakpoint
CREATE INDEX "document_links_target_document" ON "document_links" USING btree ("target_document_id"); /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table created empty in this migration; nothing to scan) */--> statement-breakpoint
CREATE INDEX "document_links_ahead" ON "document_links" USING btree ("ahead_id"); /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table created empty in this migration; nothing to scan) */--> statement-breakpoint
ALTER TABLE "document_branches" ALTER COLUMN "schema_version" SET DEFAULT 1000000;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ALTER COLUMN "schema_version" SET DEFAULT 1000000;--> statement-breakpoint
ALTER TABLE "thread_shown_links" ADD CONSTRAINT "thread_shown_links_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */--> statement-breakpoint
ALTER TABLE "thread_shown_links" ADD CONSTRAINT "thread_shown_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_settled_document_id_documents_id_fk" FOREIGN KEY ("settled_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action; /* -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table created empty in this migration; nothing to scan) */--> statement-breakpoint
CREATE INDEX "link_ahead_refs_unsettled" ON "link_ahead_refs" USING btree ("project_id","scheme","work_id",md5("path")) WHERE "link_ahead_refs"."settled_document_id" IS NULL; /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table created empty in this migration; nothing to scan) */--> statement-breakpoint
CREATE INDEX "link_ahead_refs_settled_document" ON "link_ahead_refs" USING btree ("settled_document_id"); /* -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table created empty in this migration; nothing to scan) */
