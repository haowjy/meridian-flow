-- Dead column: nothing ever wrote a non-null working_state, and the mutable
-- column was a latent frozen-prefix hazard for context-builder.ts's rendering.
ALTER TABLE "threads" DROP COLUMN "working_state";
