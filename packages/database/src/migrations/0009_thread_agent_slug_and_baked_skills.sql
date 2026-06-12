ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "threads_current_agent_id_agent_definitions_id_fk";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "current_agent_id" TYPE text USING "current_agent_id"::text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "baked_skill_slugs" jsonb;
