-- Collapse legacy run-state rows to the lifecycle default before narrowing (pre-release schema; no production users or data).
UPDATE "threads" SET "status" = 'idle' WHERE "status" NOT IN ('idle', 'archived');--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_status_valid";--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_status_valid" CHECK ("threads"."status" IN ('idle', 'archived'));
