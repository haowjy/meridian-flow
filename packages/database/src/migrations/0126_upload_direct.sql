-- migration: no-transaction
-- REQUIRES ALL WRITERS STOPPED (old and new release): the old release inserts byte_digest, fingerprint, storage_url, final_path
-- and file_type into upload_intakes at attach, the new one inserts size_bytes and leaves the other
-- two null until finish, so either release fails on chat attaches while the other's schema is live.
-- See packages/database/.context/CONTEXT.md.
-- Uploads go from the browser to the store: a row is reserved with the declared name, type and
-- size, and its final name and type are chosen when finish reads the stored bytes. The browser
-- no longer hashes the file.
BEGIN;
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP CONSTRAINT IF EXISTS "upload_intakes_digest_valid";
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP COLUMN IF EXISTS "byte_digest"; -- migration-lint: skip DROP_COLUMN (the digest only checked the browser's hash against the body; no reader remains and the old release is stopped)
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP COLUMN IF EXISTS "fingerprint"; -- migration-lint: skip DROP_COLUMN (the actor, chat, name and size it hashed are columns of the same row; no reader remains and the old release is stopped)
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP COLUMN IF EXISTS "storage_url"; -- migration-lint: skip DROP_COLUMN (the final object is always at object_key; no reader remains and the old release is stopped)
--> statement-breakpoint
ALTER TABLE "upload_intakes" ALTER COLUMN "final_path" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "upload_intakes" ALTER COLUMN "file_type" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD COLUMN IF NOT EXISTS "size_bytes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "upload_intakes" ALTER COLUMN "size_bytes" DROP DEFAULT;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "upload_intakes_open_updated"
  ON "upload_intakes" ("updated_at")
  WHERE "state" IN ('reserved', 'object_stored');
