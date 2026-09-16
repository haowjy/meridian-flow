ALTER TABLE "turns" DROP CONSTRAINT "turns_agent_definition_id_agent_definitions_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_definitions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_skills" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_subagents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skills" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_installed_skills" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_definitions" CASCADE;--> statement-breakpoint
DROP TABLE "agent_skills" CASCADE;--> statement-breakpoint
DROP TABLE "agent_subagents" CASCADE;--> statement-breakpoint
DROP TABLE "skills" CASCADE;--> statement-breakpoint
DROP TABLE "user_installed_skills" CASCADE;--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "agent_definition_id"; -- migration-lint: skip DROP_COLUMN (pre-release replacement; binding is the sole Agent identity)--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP COLUMN "default_agent_slug"; -- migration-lint: skip DROP_COLUMN (unused preference superseded by exact creation selection)