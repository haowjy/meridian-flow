/** Barrel: re-exports the runtime domain's public surface — the gateway, the orchestrator loop, the permission model, the turn runner, and the tool registry/executor. */
export type {
  MessageIntent,
  MessageProvenance,
  OrchestratorEvent,
} from "@meridian/contracts/threads";
export { MANUSCRIPT_URI as UNIFIED_MANUSCRIPT_URI } from "../context/manuscript-uri.js";
export type { WorkContextNotices } from "../projects/index.js";
export { createContextImageAssetPort } from "./adapters/context-image-assets.js";
export { createDrizzleRuntimeDelivery } from "./adapters/drizzle/runtime-delivery.js";
export {
  createDrizzleRunClaim,
  type DrizzleRunClaimOptions,
} from "./adapters/drizzle-run-claim.js";
export { createDrizzleThreadLock } from "./adapters/drizzle-thread-lock.js";
export {
  createInMemoryInbox,
  createInMemoryRunClaim,
  createInMemoryRunStarter,
  createInMemoryRuntimeDelivery,
  createInMemoryThreadLock,
  type InMemoryRunClaimOptions,
  type InMemoryRunStarter,
} from "./adapters/in-memory/loop-ports.js";
export {
  type AdmissionPersistencePort,
  createDrizzleAdmissionRecords,
} from "./admission/drizzle-admission-records.js";
export {
  AdmissionConflictError,
  createUserTurnAdmission,
  InvalidAdmissionError,
  type UserTurnAdmission,
} from "./admission/user-turn-admission.js";
export { createWriterTurnProducer } from "./admission/writer-turn-producer.js";
export * from "./gateway/index.js";
export {
  type BeginPromptEpochInput,
  type BoundaryCompletion,
  beginPromptEpoch,
} from "./loop/begin-prompt-epoch.js";
export type {
  CompactedThrough,
  CompactionBlockContent,
  CompactionPlan,
  CompactionProps,
  CompactionTrigger,
  CompactionTriggerSource,
  PlanCompactionInput,
  ProjectedActiveHistory,
  ResolveCompactionTriggerInput,
  RetainedTurnSlice,
} from "./loop/compaction/index.js";
export {
  CJK_CODE_POINT_TOKEN_RATES,
  CompactionBlockContentCodec,
  CompactionPropsCodec,
  DEFAULT_COMPACTION_TAIL_FRACTION,
  estimateRequestTokens,
  FILE_PART_TOKEN_ESTIMATE,
  FLOW_ABSOLUTE_CEILING,
  IMAGE_PART_TOKEN_ESTIMATE,
  planCompaction,
  projectActiveHistoryWithBakes,
  resolveCompactionTrigger,
} from "./loop/compaction/index.js";
export { createCompactionUndoReader } from "./loop/compaction-undo.js";
export {
  createNoopInterruptArtifactFlushPort,
  type InterruptArtifactFlushPort,
} from "./loop/interrupt-session.js";
export type { InterruptAutoResumePolicy, InterruptRegistry } from "./loop/interrupts.js";
export {
  createInterruptRegistry,
  EXPIRED_INTERRUPT_VALUE,
} from "./loop/interrupts.js";
export { createOrchestrator } from "./loop/orchestrator.js";
export { finalizeOrphanedTurns } from "./loop/orphaned-placeholder.js";
export {
  projectPendingInbox,
  readPendingInbox,
} from "./loop/pending-inbox.js";
export * from "./loop/permissions/index.js";
export type {
  ContextPart,
  InboxMessage,
  InboxReader,
  Lease,
  MessageBody,
  MessageDraft,
  RunClaim,
  RunId,
  RunStarter,
  ThreadPhase,
  ThreadStatus,
} from "./loop/ports.js";
export { DEFAULT_LEASE_TTL_MS } from "./loop/ports.js";
export {
  createPrefixCacheStateService,
  type DerivePrefixCacheStateInput,
  derivePrefixCacheState,
  type PrefixCacheHistory,
  type PrefixCacheState,
  type PrefixCacheStateReason,
  type PrefixCacheStateRequest,
  type PrefixCacheStateServiceDeps,
} from "./loop/prefix-cache-state.js";
export type { ReferenceReader } from "./loop/reference-context.js";
export {
  createRunSessions,
  type TurnRunner,
} from "./loop/run-session.js";
export { createRunStarter } from "./loop/run-starter.js";
export {
  type DrainRunTurnInput,
  isDrainRun,
  NoPendingWakeError,
  type PreparedRun,
  type RunOutcome,
  type RunTurnInput,
  type RunTurnPort,
  type WriterRunTurnInput,
} from "./loop/run-turn-port.js";
export type { DeliveryProducer, RuntimeDelivery } from "./loop/runtime-delivery.js";
export { sweepWakes } from "./loop/sweep-wakes.js";
export { ThreadControlError } from "./loop/thread-controls.js";
export {
  THREAD_LOCK_SEED,
  type ThreadLock,
  threadLockKey,
} from "./loop/thread-lock.js";
export {
  createWorkContextReader,
  renderWorkContext,
  WORK_CONTEXT_ACTIVE_LIMIT,
  type WorkContextReader,
} from "./loop/work-context.js";
export type { ConversationSummarizer, SummaryOutcome } from "./ports/conversation-summarizer.js";
export type { ImageAssetPort } from "./ports/image-asset.js";
export { unavailableImageAssetPort } from "./ports/image-asset.js";
export {
  appendSubagentActivity,
  appendSubagentActivityBestEffort,
  createSubagentActivityRefresher,
  emitRunActivityBestEffort,
} from "./spawn/activity-event.js";
export {
  authorizeThreadMessage,
  type ThreadMessageTargetOutcome,
} from "./spawn/authorize-thread-message.js";
export {
  type ChildRunCoordinator,
  type ChildRunCoordinatorDeps,
  type ChildRunOptions,
  type ChildRunRequest,
  createChildRunCoordinator,
  type SpawnChildInput,
  type ThreadMessageChildInput,
} from "./spawn/child-run-coordinator.js";
export {
  type ChildDriveInput,
  type ChildRunDriver,
  type ChildRunDriverDeps,
  createChildRunDriver,
} from "./spawn/child-run-driver.js";
export { createOrphanReportRepair } from "./spawn/orphan-report-repair.js";
export { createReportPublisher, type ReportPublisher } from "./spawn/report-publisher.js";
export { createConversationSummarizer } from "./summary/conversation-summarizer.js";
export * from "./tools/index.js";
