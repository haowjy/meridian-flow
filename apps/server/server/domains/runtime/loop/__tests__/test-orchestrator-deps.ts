/**
 * Test orchestrator dependency factory: assembles the now-required runtime
 * ports with in-memory or noop adapters so each test overrides only the seam it
 * exercises. Required runtime dependencies stay visible without repeating the
 * whole DI graph in every fixture.
 */
import type { ProjectPreferences } from "@meridian/contracts/preferences";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryPackageStore } from "../../../packages/index.js";
import { createInMemoryProjectPreferencesRepository } from "../../../preferences/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import type { Gateway } from "../../gateway/index.js";
import { createInertGateway } from "../../gateway/test-gateway.js";
import { createInMemoryModelRequestDebugStore } from "../../model-request-debug/index.js";
import type { ChildRunCoordinator } from "../../spawn/child-run-coordinator.js";
import { createToolRegistry, type ToolExecutor } from "../../tools/index.js";
import { createNoopCheckpointArtifactFlushPort } from "../checkpoint-session.js";
import { createCheckpointRegistry } from "../checkpoints.js";
import type { OrchestratorDeps } from "../orchestrator.js";
import {
  computeEffectivePermissions,
  createPermissionGate,
  resolveProfile,
} from "../permissions/index.js";

function inertGateway(): Gateway {
  return createInertGateway();
}

function inertToolExecutor(): ToolExecutor {
  return {
    executeTool: async (call) => ({ toolCallId: call.id, output: { ok: true } }),
  };
}

function noopChildRunCoordinator(): ChildRunCoordinator {
  return {
    async spawnChild() {
      throw new Error("Test child run coordinator not configured");
    },
    async spawnChildBackground() {
      throw new Error("Test child run coordinator not configured");
    },
    createReturnResultCompleter() {
      return async () => ({ ok: true as const });
    },
  };
}

export function createTestOrchestratorDeps(
  overrides: Partial<OrchestratorDeps> = {},
): OrchestratorDeps {
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const preferences = createInMemoryProjectPreferencesRepository();
  const projectPreferences = {
    async read(userId: string, projectId: string): Promise<ProjectPreferences> {
      return preferences.read(userId, projectId);
    },
  };

  return {
    gateway: inertGateway(),
    toolExecutor: inertToolExecutor(),
    repos,
    eventWriter: createInMemoryEventJournalWriter(),
    packageRepository: createInMemoryPackageStore(),
    toolRegistry: createToolRegistry(),
    projectPreferences,
    permissionGate: createPermissionGate(computeEffectivePermissions(resolveProfile("coding"))),
    creditLedger: createInMemoryCreditLedger(),
    checkpointArtifacts: createNoopCheckpointArtifactFlushPort(),
    childRunCoordinator: noopChildRunCoordinator(),
    checkpointRegistry: createCheckpointRegistry(),
    eventSink: createInMemoryEventSink(),
    modelRequestDebug: createInMemoryModelRequestDebugStore(),
    undoNotifications: {
      async record() {},
      async consumeForThread() {
        return [];
      },
    },
    responseWrites: {
      async commitResponse() {
        return [];
      },
      async rollbackResponse() {},
    },
    ...overrides,
  };
}
