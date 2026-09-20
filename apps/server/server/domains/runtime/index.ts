/** Barrel: re-exports the runtime domain's public surface — the gateway, the orchestrator loop, the permission model, the turn runner, and the tool registry/executor. */
export type { OrchestratorEvent } from "@meridian/contracts/threads";
export { MANUSCRIPT_URI as UNIFIED_MANUSCRIPT_URI } from "../context/manuscript-uri.js";
export type { WorkContextDelivery } from "../projects/index.js";
export { createContextImageAssetPort } from "./adapters/context-image-assets.js";
export { createDrizzleInbox } from "./adapters/drizzle-inbox.js";
export {
  createDrizzleRunAuthority,
  createDrizzleThreadRunOwnership,
  type DrizzleRunAuthorityOptions,
} from "./adapters/drizzle-thread-run-ownership.js";
export {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryRunStarter,
  type InMemoryRunAuthority,
  type InMemoryRunAuthorityOptions,
  type InMemoryRunStarter,
} from "./adapters/in-memory/loop-ports.js";
export { createAdmissionTurnStarter } from "./admission/admission-turn-starter.js";
export {
  type AdmissionPersistencePort,
  createDrizzleAdmissionRecords,
} from "./admission/drizzle-admission-records.js";
export {
  AdmissionConflictError,
  createHostTurnAdmission,
  createUserTurnAdmission,
  type HostTurnAdmission,
  type HostTurnAdmissionInput,
  InvalidAdmissionError,
  type UserTurnAdmission,
} from "./admission/user-turn-admission.js";
export * from "./gateway/index.js";
export {
  createNoopInterruptArtifactFlushPort,
  type InterruptArtifactFlushPort,
} from "./loop/interrupt-session.js";
export type { InterruptAutoResumePolicy, InterruptRegistry } from "./loop/interrupts.js";
export {
  createInterruptRegistry,
  EXPIRED_INTERRUPT_VALUE,
} from "./loop/interrupts.js";
export {
  createHeartbeatRunAuthority,
  type HeartbeatRunAuthorityOptions,
} from "./loop/lease-heartbeat.js";
export { createOrchestrator } from "./loop/orchestrator.js";
export * from "./loop/permissions/index.js";
export type {
  ContextPart,
  Inbox,
  InboxMessage,
  Lease,
  MessageBody,
  MessageDraft,
  MessageIntent,
  MessageProvenance,
  RunAuthority,
  RunId,
  RunStarter,
  ThreadPhase,
  ThreadStatus,
} from "./loop/ports.js";
export { DEFAULT_LEASE_TTL_MS } from "./loop/ports.js";
export type { ReferenceReader } from "./loop/reference-context.js";
export {
  createLateBindRunTurnPort,
  type ReturnResultCompleter,
  type RunTurnHandle,
  type RunTurnInput,
  type RunTurnPort,
} from "./loop/run-turn-port.js";
export {
  createInMemoryThreadRunOwnership,
  type ThreadRunClaim,
  type ThreadRunOwnership,
} from "./loop/thread-run-ownership.js";
export {
  type ChildRunRegistry,
  createTurnRunner,
  type TurnRunner,
} from "./loop/turn-runner.js";
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
  authorizeContinueTarget,
  type ContinueTargetOutcome,
} from "./spawn/authorize-continue-target.js";
export {
  type ChildReportDelivery,
  type ChildReportDeliveryDeps,
  type ChildReportEnqueue,
  createChildReportDelivery,
} from "./spawn/child-report-delivery.js";
export {
  type ChildRunCoordinator,
  type ChildRunCoordinatorDeps,
  type ChildRunOptions,
  type ChildRunRequest,
  type ContinueChildInput,
  createChildRunCoordinator,
  type SpawnChildInput,
} from "./spawn/child-run-coordinator.js";
export {
  type ChildDriveInput,
  type ChildRunDriver,
  type ChildRunDriverDeps,
  createChildRunDriver,
} from "./spawn/child-run-driver.js";
export * from "./tools/index.js";
