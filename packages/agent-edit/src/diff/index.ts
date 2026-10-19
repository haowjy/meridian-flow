/** `@meridian/agent-edit/diff`: the pure text model shared by review, Apply, Discard and the rebase. */

export {
  APPLY_RECORD_ROOT,
  type ApplyEntry,
  appendApplyRecord,
  readApplyRecord,
} from "./apply-record.js";
export {
  type AttributionPart,
  type Author,
  applyRecordOf,
  type ChangeClassification,
  type ClassifyOptions,
  classifyChanges,
  type ItemRange,
  type Provenance,
} from "./attribution.js";
export {
  applyBase,
  applySpanPatches,
  baseViewDelta,
  type SpanPatch,
  type SpanPatchError,
  validateSpanPatches,
} from "./compose.js";
export {
  convertLegacyDraft,
  DRAFT_SERVER_CLIENT_ID,
  type LegacyDraftConversion,
} from "./draft-base.js";
export { blocksEqual } from "./equal.js";
export { REVIEW_BASE_FRAGMENT, readBlocks } from "./fragments.js";
export { type BlockDiff, diffBlocks, type Hunk } from "./hunks.js";
export { findLostEdits, invisibleInsertions, type LostEdit } from "./late-peer.js";
export {
  type LateRecovery,
  type LateTyping,
  NO_LATE_TYPING,
  recoverLatePeerEdits,
} from "./late-peer-recovery.js";
export { type Conflict, type RebaseResult, rebase } from "./merge.js";
export {
  RESTORED_ROOT,
  type RestorationLink,
  readRestorations,
  recordRestorations,
  recordWriteBack,
} from "./restorations.js";
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
export { countWords, groupWordDelta, type WordDelta, wordDeltaBetweenTexts } from "./word-count.js";
export { pmToY, type WriteStats, writeBlocks, writeDiscardBlocks } from "./writer.js";
