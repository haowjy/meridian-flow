UPDATE "threads"
SET "composed_system_prompt" = replace(
  "composed_system_prompt",
  'use `ls` and `grep` for discovery',
  'use `ls` and `search` for discovery'
)
WHERE "composed_system_prompt" LIKE '%use `ls` and `grep` for discovery%';--> statement-breakpoint
