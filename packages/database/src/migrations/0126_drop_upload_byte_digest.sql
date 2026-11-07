-- migration: no-transaction
-- REQUIRES ALL WRITERS STOPPED (old and new release): the old release inserts byte_digest into
-- upload_intakes and the new one does not, so either release fails on chat attaches while the
-- other's schema is live. See packages/database/.context/CONTEXT.md.
-- Upload intake streams its bytes and no longer hashes them; the fingerprint is name and size.
BEGIN;
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP CONSTRAINT IF EXISTS "upload_intakes_digest_valid";
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP COLUMN IF EXISTS "byte_digest"; -- migration-lint: skip DROP_COLUMN (the digest only checked the browser's hash against the body; no reader remains and the old release is stopped)
--> statement-breakpoint
COMMIT;
