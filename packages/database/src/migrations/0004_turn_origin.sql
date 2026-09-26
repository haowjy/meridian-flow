-- Who authored a turn, independent of `role`. No default going forward:
-- every insert states it (see turns.origin in schema/agent-threads.ts). An
-- existing dev DB has turns already, so this adds the column nullable,
-- backfills from the durable `role` column, then locks it down. Backfill is
-- an approximation for historical `user`-role rows (writer sends and
-- non-writer inbox-drained messages both used that role before this column
-- existed, so they cannot be told apart after the fact); baseline data
-- doesn't matter here since there are no real users yet.
ALTER TABLE "turns" ADD COLUMN "origin" text;
--> statement-breakpoint
UPDATE "turns" SET "origin" = CASE -- migration-lint: skip UPDATE_WITHOUT_WHERE (the WHERE is below, on its own line)
  WHEN "role" = 'assistant' THEN 'assistant'
  WHEN "role" = 'user' THEN 'writer'
  ELSE 'system'
END
WHERE "origin" IS NULL;
--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "origin" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_origin_valid" CHECK ("turns"."origin" IN ('writer', 'assistant', 'system'));
