ALTER TABLE "threads" ADD COLUMN "current_agent_slug" text;--> statement-breakpoint
UPDATE "threads"
SET "current_agent_slug" = "agent_definitions"."slug"
FROM "agent_definitions"
WHERE "threads"."current_agent_id" = "agent_definitions"."id";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "threads_current_agent_id_agent_definitions_id_fk";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "current_agent_id";--> statement-breakpoint
ALTER TABLE "threads" RENAME COLUMN "current_agent_slug" TO "current_agent_id";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "baked_skill_slugs" jsonb;--> statement-breakpoint
UPDATE "threads"
SET "baked_skill_slugs" = '[]'::jsonb
WHERE "system_prompt_hash" IS NOT NULL AND "baked_skill_slugs" IS NULL;
