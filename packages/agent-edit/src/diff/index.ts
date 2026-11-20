/** `@meridian/agent-edit/diff`: the pure text model shared by review, Apply and Discard. */

export { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
export {
  APPLY_RECORD_ROOT,
  type ApplyEntry,
  appendApplyRecord,
  readApplyRecord,
  removeApplyRecords,
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
  type WriterReceipt,
} from "./attribution.js";
export {
  applySpanPatches,
  baseViewDelta,
  composeHunks,
  type SpanPatch,
  type SpanPatchError,
  validateSpanPatches,
} from "./compose.js";
export { DRAFT_SERVER_CLIENT_ID } from "./draft-base.js";
export { blocksEqual } from "./equal.js";
export { REVIEW_BASE_FRAGMENT, readBlocks } from "./fragments.js";
export { type BlockDiff, diffBlocks, type Hunk } from "./hunks.js";
export {
  RESTORED_ROOT,
  type RestorationLink,
  readRestorations,
  recordRestorations,
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
export { diffKeys, type Tok, wordDiff } from "./tokens.js";
export { countWords } from "./word-count.js";
export { type WriteStats, writeBlocks } from "./writer.js";
