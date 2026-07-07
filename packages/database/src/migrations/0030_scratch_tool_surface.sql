UPDATE "context_sources"
SET "slug" = 'scratch', "name" = 'Scratch', "updated_at" = now()
WHERE "slug" = 'work' AND "work_id" IS NOT NULL;--> statement-breakpoint
UPDATE "project_results"
SET "source_path" = replace("source_path", 'work://', 'scratch://'),
    "results_uri" = replace("results_uri", 'work://', 'scratch://')
WHERE "source_path" LIKE '%work://%' OR "results_uri" LIKE '%work://%';--> statement-breakpoint
UPDATE "threads"
SET "composed_system_prompt" = regexp_replace(
  replace(replace("composed_system_prompt", 'work://', 'scratch://'), 'use list and search for discovery', 'use `ls` and `grep` for discovery'),
  'Context file URI rules:.*?(?=(\n\n|$))',
  'Context file URI rules: bare file paths resolve as `manuscript://` -- the writer''s manuscript documents. `kb://` is the project knowledge base (durable reference: characters, places, canon). `scratch://` holds working files for this work item -- plans, notes, intermediate material; never the manuscript. It belongs to this work item only: switch work items and you are in a different scratch space. Anything meant to outlive this work item belongs in `kb://` or the manuscript. `uploads://` holds files the writer attached to this work item (same scoping). `user://` is the writer''s personal files. Use `write` with command=create/read/insert/replace/undo/redo for document content; use `ls` and `grep` for discovery.',
  'n'
)
WHERE "composed_system_prompt" IS NOT NULL;--> statement-breakpoint
