DROP INDEX "threads_project_slug";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "slug" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (0083 backfills every existing handle before this constraint)--> statement-breakpoint
CREATE UNIQUE INDEX "threads_project_slug" ON "threads" USING btree ("project_id","slug"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release reservation constraint transition is atomic)
