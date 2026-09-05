/** Barrel: re-exports the runtime domain's public surface — the gateway, the orchestrator loop, the permission model, the turn runner, and the tool registry/executor. */
export type { OrchestratorEvent } from "@meridian/contracts/threads";
export { MANUSCRIPT_URI as UNIFIED_MANUSCRIPT_URI } from "../context/manuscript-uri.js";
export type { WorkContextDelivery } from "../projects/index.js";
export { createContextImageAssetPort } from "./adapters/context-image-assets.js";
export { createDrizzleThreadRunOwnership } from "./adapters/drizzle-thread-run-ownership.js";
export { createAdmissionTurnStarter } from "./admission/admission-turn-starter.js";
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
export { createOrchestrator } from "./loop/orchestrator.js";
export * from "./loop/permissions/index.js";
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
  type ChildRunCoordinator,
  createChildRunCoordinator,
} from "./spawn/child-run-coordinator.js";
export {
  createHelperResultDelivery,
  type HelperResultDelivery,
} from "./spawn/helper-result-delivery.js";
export * from "./tools/index.js";
