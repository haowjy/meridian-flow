ALTER TABLE "agent_edit_mutations" ADD COLUMN "actor_kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD COLUMN "user_id" text;