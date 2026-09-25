/** Barrel: re-exports the runtime domain's public surface — the gateway, the orchestrator loop, the permission model, the turn runner, and the tool registry/executor. */
export type {
  MessageIntent,
  MessageProvenance,
  OrchestratorEvent,
} from "@meridian/contracts/threads";
export { MANUSCRIPT_URI as UNIFIED_MANUSCRIPT_URI } from "../context/manuscript-uri.js";
export type { WorkContextDelivery } from "../projects/index.js";
export { createContextImageAssetPort } from "./adapters/context-image-assets.js";
export { createDrizzleInbox } from "./adapters/drizzle-inbox.js";
export { createDrizzleThreadLock } from "./adapters/drizzle-thread-lock.js";
export {
  createDrizzleRunAuthority,
  createDrizzleThreadRunOwnership,
  type DrizzleRunAuthorityOptions,
} from "./adapters/drizzle-thread-run-ownership.js";
export {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryRunStarter,
  createInMemoryThreadLock,
  type InMemoryRunAuthorityOptions,
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
export { type CloseRunOutcome, closeRun } from "./loop/close-run.js";
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
export {
  createNotifyingThreadedInbox,
  projectPendingInbox,
  readPendingInbox,
} from "./loop/pending-inbox.js";
export * from "./loop/permissions/index.js";
export type {
  ContextPart,
  Inbox,
  InboxMessage,
  Lease,
  MessageBody,
  MessageDraft,
  RunAuthority,
  RunId,
  RunStarter,
  ThreadPhase,
  ThreadStatus,
} from "./loop/ports.js";
export { DEFAULT_LEASE_TTL_MS } from "./loop/ports.js";
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
export { sweepWakes } from "./loop/sweep-wakes.js";
export {
  THREAD_LOCK_SEED,
  type ThreadLock,
  threadLockKey,
} from "./loop/thread-lock.js";
export {
  createInMemoryThreadRunOwnership,
  type ThreadRunClaim,
  type ThreadRunOwnership,
} from "./loop/thread-run-ownership.js";
export { createThreadedInbox, type ThreadedInbox } from "./loop/threaded-inbox.js";
export {
  createWorkContextReader,
  renderWorkContext,
  WORK_CONTEXT_ACTIVE_LIMIT,
  type WorkContextReader,
} from "./loop/work-context.js";
export { createWorkContextDelivery } from "./loop/work-context-delivery.js";
export type { ImageAssetPort } from "./ports/image-asset.js";
export { unavailableImageAssetPort } from "./ports/image-asset.js";
export {
  appendSubagentActivity,
  appendSubagentActivityBestEffort,
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
export * from "./tools/index.js";
