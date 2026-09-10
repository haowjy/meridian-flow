CREATE TABLE "context_catalog_commits" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commit_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"first_revision" bigint NOT NULL,
	"last_revision" bigint NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_catalog_entries" (
	"scope_key" text NOT NULL,
	"entry_id" text NOT NULL,
	"entry" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_catalog_entries_scope_key_entry_id_pk" PRIMARY KEY("scope_key","entry_id")
);
--> statement-breakpoint
CREATE TABLE "context_catalog_scope_heads" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"head_revision" bigint DEFAULT 0 NOT NULL,
	"oldest_revision" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_catalog_commits" ADD CONSTRAINT "context_catalog_commits_scope_key_context_catalog_scope_heads_scope_key_fk" FOREIGN KEY ("scope_key") REFERENCES "public"."context_catalog_scope_heads"("scope_key") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
ALTER TABLE "context_catalog_entries" ADD CONSTRAINT "context_catalog_entries_scope_key_context_catalog_scope_heads_scope_key_fk" FOREIGN KEY ("scope_key") REFERENCES "public"."context_catalog_scope_heads"("scope_key") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)
--> statement-breakpoint
CREATE UNIQUE INDEX "context_catalog_commits_scope_revision_uq" ON "context_catalog_commits" USING btree ("scope_key","first_revision"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
--> statement-breakpoint
CREATE INDEX "context_catalog_commits_commit_idx" ON "context_catalog_commits" USING btree ("commit_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
--> statement-breakpoint
CREATE INDEX "context_catalog_entries_parent_idx" ON "context_catalog_entries" USING btree ("scope_key",("entry"->>'parentId')); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
--> statement-breakpoint
CREATE INDEX "context_catalog_entries_uri_idx" ON "context_catalog_entries" USING btree ("scope_key",("entry"->>'uri')); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)
