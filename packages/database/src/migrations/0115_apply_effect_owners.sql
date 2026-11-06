SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "apply_command_effects" ADD COLUMN "owners" jsonb;
