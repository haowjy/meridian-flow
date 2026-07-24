// Explicit composition and low-level integration surface for agent-edit hosts.
export {
  classifyDestructiveSnapshotEffect,
  type DestructiveEffect,
  type DestructiveSnapshotInput,
} from "./apply/destructive-classification.js";
export type { BlockSnapshot } from "./apply/echo.js";
export {
  applyConcurrentUpdates,
  CONCURRENT_REWRITE_DENSITY,
  DEFAULT_CONCURRENT_RUN_GAP,
  diffSnapshots,
  lineageCovered,
  renderConcurrentRuns,
  snapshotBlocks,
  touchedBlockHashesBetween,
} from "./apply/echo.js";
export type { ConcurrentEditInfo, ConcurrentEditRun } from "./apply/types.js";
export type { AgentEditCodec } from "./codec-adapter.js";
export { createAgentEditCodec } from "./codec-adapter.js";
export type { Block, Span } from "./codec-types.js";
export {
  applyConcurrentRenderBudget,
  type ConcurrentRenderBudget,
  renderedRunBytes,
} from "./concurrent-render-budget.js";
export type { DocumentAddress, ParseDocumentAddressResult } from "./document-address.js";
export { formatDocumentFile, parseDocumentAddress, splitDocumentFile } from "./document-address.js";
export type { BlockRef, DocHandle } from "./handles.js";
export { toDocHandle, toRef, unwrapBlock, unwrapDoc } from "./handles.js";
export * from "./index.js";
export type { LineageRange, WriterLineageRange } from "./lineage/range-set.js";
export {
  groupLineageRanges,
  intersectLineageRanges,
  lineageRangesContain,
  normalizeLineageRanges,
  subtractLineageRanges,
} from "./lineage/range-set.js";
export type { BlockItemId } from "./model/block-hash.js";
export { getBlockItemId } from "./model/block-hash.js";
export type { YProsemirrorDocumentModel } from "./model/y-prosemirror.js";
export { fragmentOf, yProsemirrorModel } from "./model/y-prosemirror.js";
export type {
  ActorSession,
  ActorSessionDocumentState,
  ActorSessionStore,
} from "./ports/actor-session-store.js";
export type { DocumentCoordinator, DocumentLockOptions } from "./ports/document-coordinator.js";
export {
  DocumentNotFoundError,
  isDocumentNotFoundError,
} from "./ports/document-coordinator.js";
export type { DocumentLifecycle } from "./ports/document-lifecycle.js";
export type {
  AgentEditModel,
  BlockLookup,
  CanonicalBlockIdentity,
  DocumentModel,
  TextRun,
} from "./ports/model.js";
export type { SemanticProvenanceWriter } from "./ports/semantic-provenance.js";
export type {
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  ReversalActor,
  ReversalRecord,
  ReversalStatus,
  UpdateMeta,
  UpdateOrigin,
} from "./ports/types.js";
export type {
  ActiveWriteSummary,
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  JournalReadOptions,
  PersistRedoEntry,
  PersistUndoResult,
  ReversalStore,
  UpdateJournal,
  WriteMutationRow,
} from "./ports/update-journal.js";
export { parseWriteHandle, writeHandle } from "./ports/update-journal.js";
export type {
  MappedContinuation,
  PmSourceContinuation,
  ProseMirrorLoweringResult,
} from "./prosemirror-lowering.js";
export {
  lowerProseMirrorTransform,
  propagateContinuations,
  validateLoweredTargetPartition,
} from "./prosemirror-lowering.js";
export type {
  RestorationCertificatePort,
  SemanticEditIRV1,
  SemanticOutputRun,
  Utf16Span,
} from "./semantic-edit-ir.js";
export { validateOutputPartition, validateSemanticEditIRV1 } from "./semantic-edit-ir.js";
export type { DestructiveSweepReport } from "./tool/mutation-commit.js";
export type { ReversalNoticeFailedDetail, ReversalNoticePort } from "./tool/write-reversal.js";
export type { UndoAvailability } from "./undo/availability.js";
export type {
  PersistUndoWatermarkRecord,
  PersistUndoWatermarkUpdate,
} from "./undo/persist-undo-watermark.js";
export {
  hasLaterNonSystemUpdateAfterWatermark,
  isLaterNonSystemUpdateAfterWatermark,
  persistUndoPlanWatermark,
} from "./undo/persist-undo-watermark.js";
export type { ReconstructionOptions, UndoReconstructionResult } from "./undo/reconstruction.js";
export { reconstructUndoUpdateFromSnapshot } from "./undo/reconstruction.js";
export type { ReversalSelection } from "./undo/reversal-plan.js";
export {
  applyYjsUpdateIfEffective,
  bytesEqual,
  cloneYDoc,
  effectiveYjsUpdate,
  yjsDeltaUpdate,
  yjsUpdateChangesDoc,
  yjsUpdateFromState,
} from "./yjs-update.js";
