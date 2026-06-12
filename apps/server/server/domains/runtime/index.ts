// @ts-nocheck
/** Barrel: re-exports the runtime domain's public surface — the gateway, the orchestrator loop, the permission model, the turn runner, and the tool registry/executor. */
export type { OrchestratorEvent } from "@meridian/contracts/threads";
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
  type ChildRunRegistry,
  createTurnRunner,
  type TurnRunner,
} from "./loop/turn-runner.js";
export {
  type ChildRunCoordinator,
  createChildRunCoordinator,
} from "./spawn/child-run-coordinator.js";
export * from "./tools/index.js";

export const REQUIRED_MANUSCRIPT_URI = "work://manuscript/chapter-1.md";
export type RuntimeToolAction =
  | { tool: "edit"; uri: string; mode: "append"; text: string }
  | { tool: "write"; uri: string; markdown: string };
