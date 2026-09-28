/** Barrel: re-exports the threads domain's public surface — drizzle + in-memory repositories and event journals, the thread event hub, snapshot builder, access gate, and port types. */

export type { DrizzleDatabase } from "../../shared/drizzle-transaction.js";
export { createDrizzleEventJournalReader } from "./adapters/drizzle/event-reader.js";
export { createDrizzleEventJournalWriter } from "./adapters/drizzle/event-writer.js";
export {
  createInMemoryEventJournalReader,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "./adapters/in-memory/index.js";
export {
  type ActiveDocumentResolver,
  createActiveDocumentResolver,
} from "./domain/active-document-resolver.js";
export { createBoundConversation } from "./domain/bound-conversation.js";
export { ForkCutoffOwnerNotFoundError, findCutoffOwnerThreadId } from "./domain/cutoff-owner.js";
export {
  DerivedSourceNotFoundError,
  DerivedThreadConflictError,
  ForkCutoffError,
  type ForkCutoffErrorCode,
  forkThreadAgent,
  handoffThreadAgent,
  SubagentDerivationError,
  type ThreadAgentSwapDeps,
} from "./domain/derive-conversation.js";
export { ExecutionReportConflictError } from "./domain/execution-report-conflict.js";
export { isInSubtree, type LineageThread, sameLineage } from "./domain/lineage.js";
export {
  createOrchestratorEventProjector,
  projectOrchestratorEvents,
} from "./domain/orchestrator-event-projector.js";
export { hashPromptBakeContent } from "./domain/prompt-bake-hash.js";
export {
  bakeAt,
  bakeIdAt,
  bakeInEffect,
  PromptBakeNotFoundError,
  PromptBakeTurnNotFoundError,
  type PromptEpochReader,
} from "./domain/prompt-epochs.js";
export { projectReadModelEvent } from "./domain/read-model-projector.js";
export {
  RebindThreadWorkError,
  type RebindThreadWorkInput,
  rebindThreadWork,
} from "./domain/rebind-thread-work.js";
export {
  projectThreadActivity,
  readThreadActivity,
  type ThreadActivityReadDeps,
} from "./domain/thread-activity.js";
export {
  loadThreadConversationContext,
  type ThreadConversationContext,
  type ThreadConversationContextDeps,
  ThreadConversationContextError,
  type ThreadConversationContextErrorCode,
} from "./domain/thread-conversation-context.js";
export {
  requireWorkDraftOwner,
  threadExecutionContext,
  WorkRequiredError,
} from "./domain/thread-execution-context.js";
export {
  type ThreadTrashState,
  type ThreadTrashTransition,
  ThreadTrashUnavailableError,
  transitionThreadTrash,
} from "./domain/thread-trash-lifecycle.js";
export {
  cursorAfter,
  InvalidTranscriptCursorError,
  readTranscriptItem,
  readTranscriptPage,
  readTranscriptPageForProjection,
  resolveTranscriptSpans,
  type TranscriptOrder,
  type TranscriptOwner,
  type TranscriptPage,
  type TranscriptPageInput,
  type TranscriptRange,
  type TranscriptSegment,
  type TranscriptSpanResolution,
  type TranscriptUnit,
} from "./domain/transcript-page.js";
export type {
  AgentRequestOrigin,
  AgentRequestSource,
  CompactionFailureOutcome,
  CompactionFailurePhase,
  CompactionFailureReason,
  CompactionMetadata,
  CompactionPlanMetadata,
  CompactionUndoFailureReason,
  HistoryItemClass,
  ImageContextBreak,
  ImageInclusionMetadata,
} from "./domain/turn-metadata.js";
export {
  activeCompaction,
  agentRequestMetadata,
  ChildCompletionMetadataCodec,
  ChildCompletionMetadataTagCodec,
  CompactionFailureOutcomeCodec,
  CompactionFailurePhaseCodec,
  CompactionFailureReasonCodec,
  CompactionMetadataCodec,
  CompactionPlanMetadataCodec,
  CompactionUndoMetadataCodec,
  childCompletionMetadata,
  childSeedMetadata,
  classifyHistoryItem,
  compactionFailureMetadata,
  compactionSummaryMetadata,
  compactionTurnMetadata,
  compactionUndoMetadata,
  DerivationSeedMetadataCodec,
  decodeImageInclusionMetadata,
  derivationSeedMetadata,
  encodeImageInclusionMetadata,
  foregroundMessageMetadata,
  HandoffSeedMetadataCodec,
  handoffSeedMetadata,
  ImageContextBreakCodec,
  ImageInclusionMetadataCodec,
  InboxMessageMetadataCodec,
  inboxMessageMetadata,
  interruptedPlaceholderError,
  isPromptEpochMetadata,
  isSystemUpdateMetadata,
  noticesMetadata,
  PromptEpochMetadataCodec,
  promptEpochMetadata,
  revertedCompactionIds,
  SavedSubagentReportMetadataCodec,
  SteerMetadataCodec,
  SystemUpdateMetadataCodec,
  savedSubagentReportMetadata,
  skillBodyMetadata,
  steerMetadata,
  workUpdateMetadata,
  writerSendMetadata,
} from "./domain/turn-metadata.js";
export {
  TurnStartConflictError,
  type TurnStartConflictReason,
} from "./domain/turn-start-transition.js";
export type { HandoffControlQueue } from "./ports/handoff-control-queue.js";
export * from "./ports/index.js";
export { createThreadRuntimeService, type ThreadRuntimeService } from "./runtime-service.js";
export {
  deleteOwnedThreadToTrash,
  requireThreadOwner,
  restoreOwnedThreadFromTrash,
  type SetOwnedThreadTrashStateDeps,
  setOwnedThreadTrashState,
} from "./thread-access.js";
export {
  createThreadEventHub,
  type SequencedEventInternal,
  type ThreadEventHub,
} from "./thread-event-hub.js";
export { buildThreadSnapshot } from "./thread-snapshot.js";
