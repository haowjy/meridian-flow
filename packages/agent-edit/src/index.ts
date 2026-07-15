// Supported public surface for the agent editing core.
import { type CreateWriteToolOptions, createWriteTool } from "./tool/write.js";

export type AgentEditCoreOptions = CreateWriteToolOptions;

export interface AgentEditCore {
  write: ReturnType<typeof createWriteTool>["write"];
  recover: ReturnType<typeof createWriteTool>["recover"];
  commitResponse: ReturnType<typeof createWriteTool>["commitResponse"];
  rollbackResponse: ReturnType<typeof createWriteTool>["rollbackResponse"];
  bufferedUpdatesForDoc: ReturnType<typeof createWriteTool>["bufferedUpdatesForDoc"];
  stagedCreatedDocumentIds: ReturnType<typeof createWriteTool>["stagedCreatedDocumentIds"];
  getAvailability: ReturnType<typeof createWriteTool>["getAvailability"];
  undo: ReturnType<typeof createWriteTool>["undo"];
  redo: ReturnType<typeof createWriteTool>["redo"];
  reverse: ReturnType<typeof createWriteTool>["reverse"];
  undoTurn: ReturnType<typeof createWriteTool>["undoTurn"];
  redoTurn: ReturnType<typeof createWriteTool>["redoTurn"];
  invalidateThread: ReturnType<typeof createWriteTool>["invalidateThread"];
}

export function createAgentEditCore(options: AgentEditCoreOptions): AgentEditCore {
  const tool = createWriteTool(options);
  return {
    write: tool.write,
    recover: tool.recover,
    commitResponse: tool.commitResponse,
    rollbackResponse: tool.rollbackResponse,
    bufferedUpdatesForDoc: tool.bufferedUpdatesForDoc,
    stagedCreatedDocumentIds: tool.stagedCreatedDocumentIds,
    getAvailability: tool.getAvailability,
    undo: tool.undo,
    redo: tool.redo,
    reverse: tool.reverse,
    undoTurn: tool.undoTurn,
    redoTurn: tool.redoTurn,
    invalidateThread: tool.invalidateThread,
  };
}

export type { BlockSnapshot } from "./apply/echo.js";
export {
  applyConcurrentUpdates,
  CONCURRENT_REWRITE_DENSITY,
  DEFAULT_CONCURRENT_RUN_GAP,
  diffSnapshots,
  renderConcurrentRuns,
  snapshotBlocks,
  touchedBlockHashesBetween,
} from "./apply/echo.js";
export type {
  ConcurrentEditInfo,
  ConcurrentEditRun,
  ConcurrentRunObservation,
} from "./apply/types.js";
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
export type { BlockItemId } from "./model/block-hash.js";
export { getBlockItemId } from "./model/block-hash.js";
export type { LiveBlockRangeTarget } from "./model/navigation-target.js";
export {
  decodeNavigationPosition,
  encodeNavigationPosition,
  isBlockItemId,
  validateLiveBlockRange,
} from "./model/navigation-target.js";
export type { YProsemirrorDocumentModel } from "./model/y-prosemirror.js";
export { fragmentOf, yProsemirrorModel } from "./model/y-prosemirror.js";
export type {
  ExplicitDeletionObservation,
  ObservationAuthority,
  ObservationCandidate,
  RenderedObservation,
} from "./observation-snapshot.js";
export {
  createObservationAuthority,
  digestRenderedContent,
  observationCoversRendering,
} from "./observation-snapshot.js";
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
export type { AgentEditModel, BlockLookup, DocumentModel, TextRun } from "./ports/model.js";
export type {
  CanonicalBlockIdentity,
  ObservationEntry,
  ObservationKey,
  ObservationSnapshot,
  ObservationSnapshotStore,
  ObservationValue,
} from "./ports/observation-snapshot.js";
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
export type { WriteCommandCategory } from "./tool/command-schema.js";
export {
  MUTATING_WRITE_COMMANDS,
  WriteCommandSchema,
  writeCommandCategory,
} from "./tool/command-schema.js";
export type { DestructiveSweepReport } from "./tool/mutation-commit.js";
export type {
  MutationActor,
  RedoResult,
  ResponseClaimDiscardedEntry,
  ResponseCommitDocumentRejection,
  ResponseCommitDocumentResult,
  ResponseCommitRejectedResult,
  ResponseCommitResult,
  ResponseCommitSuccessResult,
  ResponseCommitterTransitionDetail,
  ResponseLifecycleClaimDiscardedDetail,
  ResponseLifecycleErrorDetail,
  ResponseLifecycleEvent,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
  TurnRedoResult,
  TurnUndoResult,
  UndoResult,
  WriteCommand,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteIdempotencyHitDetail,
  WriteOutcome,
  WriteResultBlock,
  WriteStatus,
  WriteSuccessPhase,
} from "./tool/types.js";
export type { ReverseInput, VerifiedReverseEffect, VerifiedReverseResult } from "./tool/write.js";
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
