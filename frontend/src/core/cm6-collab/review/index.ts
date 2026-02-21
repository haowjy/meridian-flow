export {
  ProposalReviewRuntime,
  createProposalReviewRuntime,
  type CreateProposalReviewRuntimeOptions,
  type ProposalOperationsReady,
  type ProposalOperationsModel,
} from "./runtime";

export {
  mountProposalReviewMergeView,
  type ProposalReviewMergeViewParams,
  type ProposalReviewMergeViewHandle,
} from "./merge";

export type {
  ProposalReviewUnavailableReason,
  ProposalReviewReady,
  ProposalReviewUnavailable,
  ProposalReviewModel,
  ProposalReviewSnapshot,
} from "./contracts";

export {
  buildPartialUpdate,
  buildEditedChunkUpdate,
  type BuildPartialUpdateOptions,
} from "./partial-apply";
export {
  startChunkEditSession,
  updateChunkEditSession,
  resetChunkEditSession,
  commitChunkEditSession,
  cancelChunkEditSession,
  type ChunkEditSession,
  type ChunkEditCommit,
} from "./chunk-editor";
export { extractProposalOps, extractProposalOpsWithClone } from "./changeset-extractor";
export { groupIntoChunks } from "./chunk-grouper";
export type {
  EditOp,
  InsertOp,
  DeleteOp,
  ReplaceOp,
  ReviewChunk,
  ReviewChunkStatus,
} from "./types";

export {
  inlineReviewExtension,
  setReviewChunksEffect,
  clearReviewEffect,
  resolveChunkEffect,
  setActiveChunkIndex,
  getInlineReviewState,
  type InlineReviewState,
  type InlineReviewCallbacks,
} from "./inline-review";
