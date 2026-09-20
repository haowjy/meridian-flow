ALTER TABLE "thread_agent_bindings" ALTER COLUMN "definition_revision_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_agent_bindings" ADD COLUMN "invocation_overlay" jsonb;
