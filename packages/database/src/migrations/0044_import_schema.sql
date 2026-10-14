SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "import_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"kind" text NOT NULL,
	"entry_id" integer,
	"state" text NOT NULL,
	"reason" text,
	"storage_url" text,
	"object_key" text,
	"converted_key" text,
	"received_size" bigint,
	"sha256" text
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"user_id" uuid NOT NULL,
	"destination_uri" text NOT NULL,
	"folder_id" uuid,
	"roots" jsonb NOT NULL,
	"placement" jsonb,
	"placement_generation" integer DEFAULT 0 NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"counts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"claims_without_progress" integer DEFAULT 0 NOT NULL,
	"fell_back" boolean DEFAULT false NOT NULL,
	"reason" text,
	"finished_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"objects_swept_at" timestamp with time zone,
	"final_sweep_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "import_entries" ADD CONSTRAINT "import_entries_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action NOT VALID;
