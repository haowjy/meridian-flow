-- Validation runs separately from ADD CHECK: its scan must not retain an ACCESS EXCLUSIVE lock.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "asks" VALIDATE CONSTRAINT "asks_permission_command_coherent";
