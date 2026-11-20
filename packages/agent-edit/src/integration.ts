// Explicit composition and low-level integration surface for agent-edit hosts.
export type { BlockSnapshot } from "./apply/echo.js";
export { snapshotBlocks } from "./apply/echo.js";
export { overwriteWithAssigned } from "./apply/overwrite.js";
export type { ConcurrentUpdate, ConcurrentUpdateOrigin } from "./apply/types.js";
export { EDIT_FAILED_MESSAGE } from "./apply/types.js";
export type { AgentEditCodec, AgentEditCodecFactory } from "./codec-adapter.js";
export { createAgentEditCodecFactory } from "./codec-adapter.js";
export type { Block, Span } from "./codec-types.js";
export type { DocumentAddress, ParseDocumentAddressResult } from "./document-address.js";
export { formatDocumentFile, parseDocumentAddress } from "./document-address.js";
export type {
  FrontierLookup,
  FrontierLookups,
  ObservationFrontier,
  ReplyMutations,
  ResolvedObservationFrontier,
  SeedAttributionBridge,
} from "./frontier.js";
export {
  createReplyMutations,
  decodeSnapshot,
  docAtFrontier,
  frontierBlockId,
  frontierDelta,
  projectSeedFrontier,
} from "./frontier.js";
export type { BlockRef, DocHandle } from "./handles.js";
export { toDocHandle, toRef, unwrapBlock, unwrapDoc } from "./handles.js";
export * from "./index.js";
export type { LineageRange } from "./lineage/range-set.js";
export {
  groupLineageRanges,
  intersectLineageRanges,
  lineageRangesContain,
  normalizeLineageRanges,
  subtractLineageRanges,
} from "./lineage/range-set.js";
export type { AssignInput, AssignResult } from "./links/assign-refs.js";
export { assignLinkRefs, assignOccurrences } from "./links/assign-refs.js";
export type { ShownLink } from "./links/correspondence.js";
export type { OccurrenceAttrs } from "./links/occurrences.js";
export { rebuildOccurrences, sameAttrs } from "./links/occurrences.js";
export type { LinkShowing } from "./links/shown.js";
export type { BlockItemId } from "./model/block-hash.js";
export {
  type BlockOriginMap,
  bindBlockOrigins,
  blockItemIdKey,
  getBlockItemId,
  getTopLevelXmlBlocks,
} from "./model/block-hash.js";
export {
  type IdRanges,
  type PressRecord,
  pressStored,
  resolveStored,
  storedPendingChanges,
  storedPendingTurns,
  suggestingModel,
  undoPressStored,
} from "./model/suggesting-model.js";
export type { YProsemirrorDocumentModel } from "./model/y-prosemirror.js";
export { fragmentOf, yProsemirrorModel } from "./model/y-prosemirror.js";
export type {
  ActorSession,
  ActorSessionStore,
} from "./ports/actor-session-store.js";
export type {
  DocumentAccess,
  DocumentCoordinator,
  PreparedSave,
  PreparedWrite,
  RoomRead,
  SaveCut,
  SavePrecondition,
} from "./ports/document-coordinator.js";
export {
  DocumentNotFoundError,
  isDocumentNotFoundError,
  SavePreconditionRefused,
} from "./ports/document-coordinator.js";
export type {
  DocumentEditRequest,
  DocumentEditResult,
  DocumentEdits,
  ModelInverseCommand,
} from "./ports/document-edits.js";
export type {
  AheadMint,
  DocumentLinksPort,
  LinkPrepareRequest,
} from "./ports/document-links.js";
export type {
  AgentEditModel,
  CanonicalBlockIdentity,
  DocumentModel,
} from "./ports/model.js";
export type {
  StaticCatalogDocument,
  StaticDocumentCatalog,
} from "./ports/static-document-links.js";
export {
  createStaticDocumentLinks,
  type StaticDocumentLinksOptions,
} from "./ports/static-document-links.js";
export type {
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  UpdateMeta,
  UpdateOrigin,
} from "./ports/types.js";
export type {
  AgentEditJournal,
  JournalAuthority,
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  JournalReadOptions,
  UpdateJournal,
} from "./ports/update-journal.js";
export { editHandle, parseEditHandle } from "./ports/update-journal.js";
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
  SemanticEditIRV1,
  SemanticOutputRun,
  Utf16Span,
} from "./semantic-edit-ir.js";
export { validateOutputPartition, validateSemanticEditIRV1 } from "./semantic-edit-ir.js";
export { returnedWriteResult } from "./tool/receipt.js";
export { isWriteErrorStatus } from "./tool/response-format.js";
export type { LinkSpliceFallbackDetail, ObservationFailedDetail } from "./tool/write-deps.js";
export { heldDeletes } from "./undo/held-deletes.js";
export type {
  CapturedPart,
  EditEffect,
  EditKind,
  EditRange,
  EditTarget,
} from "./undo/receipt.js";
export { captureEditParts } from "./undo/receipt.js";
export {
  applyYjsUpdateIfEffective,
  bytesEqual,
  cloneYDoc,
  effectiveYjsUpdate,
  yjsDeltaUpdate,
  yjsUpdateChangesDoc,
  yjsUpdateFromState,
} from "./yjs-update.js";
