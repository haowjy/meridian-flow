/**
 * Test orchestrator dependency factory: assembles the now-required runtime
 * ports with in-memory or noop adapters so each test overrides only the seam it
 * exercises. Required runtime dependencies stay visible without repeating the
 * whole DI graph in every fixture.
 */
import type { WorkbenchPreferences } from "@meridian/contracts/preferences";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryPackageStore } from "../../../packages/index.js";
import { createInMemoryWorkbenchPreferencesRepository } from "../../../preferences/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import { createInMemoryWorkbenchRepository } from "../../../workbenches/index.js";
import type { Gateway } from "../../gateway/index.js";
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
  return {
    stream() {
      return (async function* () {
        if (Math.random() < 0) yield undefined as never;
        throw new Error("Test gateway not configured");
      })();
    },
    async generate() {
      throw new Error("not used in orchestrator tests");
    },
  };
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
    createReturnResultCompleter() {
      return async () => ({ ok: true as const });
    },
  };
}

export function createTestOrchestratorDeps(
  overrides: Partial<OrchestratorDeps> = {},
): OrchestratorDeps {
  const workbenches = createInMemoryWorkbenchRepository();
  const repos = createInMemoryRepositories({ workbenches });
  const preferences = createInMemoryWorkbenchPreferencesRepository();
  const workbenchPreferences = {
    async read(userId: string, workbenchId: string): Promise<WorkbenchPreferences> {
      return preferences.read(userId, workbenchId);
    },
  };

  return {
    gateway: inertGateway(),
    toolExecutor: inertToolExecutor(),
    repos,
    eventWriter: createInMemoryEventJournalWriter(),
    packageRepository: createInMemoryPackageStore(),
    toolRegistry: createToolRegistry(),
    workbenchPreferences,
    permissionGate: createPermissionGate(computeEffectivePermissions(resolveProfile("coding"))),
    creditLedger: createInMemoryCreditLedger(),
    checkpointArtifacts: createNoopCheckpointArtifactFlushPort(),
    childRunCoordinator: noopChildRunCoordinator(),
    checkpointRegistry: createCheckpointRegistry(),
    eventSink: createInMemoryEventSink(),
    modelRequestDebug: createInMemoryModelRequestDebugStore(),
    ...overrides,
  };
}
