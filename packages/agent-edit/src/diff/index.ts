/** `@meridian/agent-edit/diff`: the pure text model shared by review, Apply, Discard and the rebase. */
export { applySpanPatches } from "./compose.js";
export {
  convertLegacyDraft,
  DRAFT_SERVER_CLIENT_ID,
  type LegacyDraftConversion,
  UNKNOWN_BASE_REVISION,
} from "./draft-base.js";
export { blocksEqual } from "./equal.js";
export { REVIEW_BASE_FRAGMENT, readBlocks } from "./fragments.js";
export { type BlockDiff, diffBlocks, type Hunk } from "./hunks.js";
export { findLostEdits, invisibleInsertions, type LostEdit } from "./late-peer.js";
export { type LateRecovery, recoverLatePeerEdits } from "./late-peer-recovery.js";
export { type Conflict, type RebaseResult, rebase } from "./merge.js";
export {
  appendRebaseCut,
  captureRebaseCut,
  decodeRebaseCuts,
  MAX_REBASE_CUT_BYTES,
  MAX_REBASE_CUTS,
} from "./rebase-cuts.js";
export {
  composeGroups,
  type ProseMirrorJSON,
  projectReview,
  type ReviewGroup,
  type ReviewHunk,
  type ReviewProjection,
  type ReviewSpan,
} from "./review.js";
export type { Tok } from "./tokens.js";
export { pmToY, type WriteStats, writeBlocks } from "./writer.js";
export {
  type AttributionEdit,
  type ChatHint,
  editsInChanges,
  type ItemRange,
  matchAttribution,
} from "./yjs-attribution.js";
