SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "import_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"kind" text NOT NULL,
	"entry_id" integer,
	"parent_id" uuid,
	"area" text,
	"prepared" boolean DEFAULT false NOT NULL,
	"state" text NOT NULL,
	"created" boolean DEFAULT false NOT NULL,
	"attempt_id" uuid,
	"lease_until" timestamp with time zone,
	"storage_url" text,
	"uri" text,
	"object_swept_at" timestamp with time zone,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_progress" (
	"import_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"destination_uri" text NOT NULL,
	"roots" jsonb NOT NULL,
	"existing_links" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"source_id" uuid NOT NULL,
	"folder_id" uuid,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD COLUMN "awaited_document_id" uuid;
--> statement-breakpoint
ALTER TABLE "import_entries" ADD CONSTRAINT "import_entries_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "import_progress" ADD CONSTRAINT "import_progress_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
