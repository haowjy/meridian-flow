SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
-- Nullable, no default: metadata-only on a populated table. Admissions recorded before this have no
-- version; their replay answers null and the client adds no intent for them.
ALTER TABLE "user_turn_admissions" ADD COLUMN "run_state_version" text;
