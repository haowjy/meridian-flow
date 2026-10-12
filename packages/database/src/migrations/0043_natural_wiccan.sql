SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "import_progress" (
	"import_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_entries" ADD COLUMN "version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_progress" ADD CONSTRAINT "import_progress_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "import_progress" VALIDATE CONSTRAINT "import_progress_import_id_imports_id_fk";
--> statement-breakpoint
-- Preserve existing receipts and establish their initial report cut.
INSERT INTO "import_progress" ("import_id","version","last_activity_at")
SELECT "id", 1, "created_at" FROM "imports" ON CONFLICT ("import_id") DO NOTHING;
--> statement-breakpoint
UPDATE "import_entries" SET "version" = 1 WHERE "version" = 0;
--> statement-breakpoint
-- These strings were developer-owned copy, not writer text. Keep provenance and
-- receipts, replace presentation strings with the public code/params catalog.
UPDATE "import_entries" SET "spec" =
  jsonb_set(
    jsonb_set("spec",'{reason}',coalesce(to_jsonb(
      CASE "spec"->>'reason'
        WHEN 'Edited before its text arrived' THEN 'edited_before_arrival'
        WHEN 'Deleted before its text arrived' THEN 'deleted_before_arrival'
        WHEN 'Its folder was deleted before it arrived' THEN 'folder_deleted'
        WHEN 'Obsidian canvas or database' THEN 'obsidian_canvas'
        WHEN 'Obsidian trash' THEN 'trash'
        WHEN 'Hidden file or folder' THEN 'hidden'
        ELSE CASE WHEN "spec"->>'reason' IN ('conversion_failed','upload_failed','changed_since_chosen','too_large','edited_before_arrival','deleted_before_arrival','folder_deleted','server_error','obsidian_canvas','trash','hidden','unreadable','export_works')
          THEN "spec"->>'reason' ELSE CASE WHEN "state" = 'failed' THEN 'server_error' ELSE NULL END END
      END
    ),'null'::jsonb),true),
    '{findings}',coalesce((
      SELECT jsonb_agg(
        (finding - 'message') || jsonb_build_object(
          'code',CASE WHEN finding->>'code' = 'ahead_captured' THEN 'picture_elsewhere' ELSE finding->>'code' END,
          'params',coalesce(finding->'params',CASE finding->>'code'
            WHEN 'folder_note' THEN '{}'::jsonb
            WHEN 'name_clash' THEN jsonb_build_object('original',"spec"->>'filename')
            WHEN 'binary_extension' THEN jsonb_build_object('original',"spec"->>'filename','type',"spec"->>'filetype')
            WHEN 'zip' THEN jsonb_build_object('name',"spec"->>'filename')
            WHEN 'ahead_captured' THEN jsonb_build_object('name',"spec"->>'filename')
            ELSE '{}'::jsonb END)
        )
      ) FROM jsonb_array_elements(coalesce("spec"->'findings','[]'::jsonb)) AS finding
    ),'[]'::jsonb),true)
WHERE "spec" ? 'reason' OR "spec" ? 'findings';
