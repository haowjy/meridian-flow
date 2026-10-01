-- Dead column: nothing ever wrote a non-null working_state, and the mutable
-- column was a latent frozen-prefix hazard for context-builder.ts's rendering.
ALTER TABLE "threads" DROP COLUMN "working_state"; -- migration-lint: skip DROP_COLUMN (no deployed data; every read removed in the same change)
