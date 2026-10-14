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
export { type Conflict, type RebaseResult, rebase } from "./merge.js";
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
