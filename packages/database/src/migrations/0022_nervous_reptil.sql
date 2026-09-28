ALTER TABLE "threads" DROP CONSTRAINT "threads_spawn_root_required";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "root_thread_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_lineage_derivations" ON "threads" USING btree ("root_thread_id") WHERE "threads"."origin_type" IN ('fork', 'handoff');