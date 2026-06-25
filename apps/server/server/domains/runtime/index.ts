/** Barrel: re-exports the runtime domain's public surface — the gateway, the orchestrator loop, the permission model, the turn runner, and the tool registry/executor. */
export type { OrchestratorEvent } from "@meridian/contracts/threads";
export { MANUSCRIPT_URI as UNIFIED_MANUSCRIPT_URI } from "../context/manuscript-uri.js";
export * from "./gateway/index.js";
export {
  type CheckpointArtifactFlushPort,
  createNoopCheckpointArtifactFlushPort,
} from "./loop/checkpoint-session.js";
export type { CheckpointAutoResumePolicy, CheckpointRegistry } from "./loop/checkpoints.js";
export {
  createCheckpointRegistry,
  EXPIRED_CHECKPOINT_VALUE,
} from "./loop/checkpoints.js";
export { createOrchestrator, type ResponseCommitEcho } from "./loop/orchestrator.js";
export * from "./loop/permissions/index.js";
export {
  createLateBindRunTurnPort,
  type ReturnResultCompleter,
  type RunTurnHandle,
  type RunTurnInput,
  type RunTurnPort,
} from "./loop/run-turn-port.js";
export {
  type ChildRunRegistry,
  createTurnRunner,
  type TurnRunner,
} from "./loop/turn-runner.js";
export {
  type ChildRunCoordinator,
  createChildRunCoordinator,
} from "./spawn/child-run-coordinator.js";
export {
  createHelperResultDelivery,
  type HelperResultDelivery,
} from "./spawn/helper-result-delivery.js";
export * from "./tools/index.js";
export type RuntimeToolAction =
  | { tool: "edit"; uri: string; mode: "append"; text: string }
  | { tool: "write"; uri: string; markdown: string };
