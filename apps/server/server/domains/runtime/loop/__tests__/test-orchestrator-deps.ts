/**
 * Test orchestrator dependency factory: assembles the now-required runtime
 * ports with in-memory or noop adapters so each test overrides only the seam it
 * exercises. Required runtime dependencies stay visible without repeating the
 * whole DI graph in every fixture.
 */
import type { ProjectPreferences } from "@meridian/contracts/preferences";
import {
  type CreditLedger,
  createBillingUsagePolicy,
  createInMemoryCreditLedger,
} from "../../../billing/index.js";
import type { Notice, NoticePort } from "../../../notices/index.js";
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
import { createNoopInterruptArtifactFlushPort } from "../interrupt-session.js";
import { createInterruptRegistry } from "../interrupts.js";
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
  overrides: Partial<OrchestratorDeps> & { creditLedger?: CreditLedger } = {},
): OrchestratorDeps & { creditLedger: CreditLedger } {
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const preferences = createInMemoryProjectPreferencesRepository();
  const projectPreferences = {
    async read(userId: string, projectId: string): Promise<ProjectPreferences> {
      return preferences.read(userId, projectId);
    },
  };

  const creditLedger = overrides.creditLedger ?? createInMemoryCreditLedger();

  return {
    gateway: inertGateway(),
    toolExecutor: inertToolExecutor(),
    repos,
    eventWriter: createInMemoryEventJournalWriter(),
    packageRepository: createInMemoryPackageStore(),
    toolRegistry: createToolRegistry(),
    projectPreferences,
    permissionGate: createPermissionGate(computeEffectivePermissions(resolveProfile("coding"))),
    billingUsage: overrides.billingUsage ?? createBillingUsagePolicy(creditLedger),
    interruptArtifacts: createNoopInterruptArtifactFlushPort(),
    childRunCoordinator: noopChildRunCoordinator(),
    interruptRegistry: createInterruptRegistry(),
    eventSink: createInMemoryEventSink(),
    modelRequestDebug: createInMemoryModelRequestDebugStore(),
    notices: createTestNoticePort(),
    responseWrites: {
      setReadRequiredFence() {},
      async commitResponse() {
        return { status: "committed", concurrentEdits: [] };
      },
      async rollbackResponse() {},
    },
    ...overrides,
    creditLedger,
  };
}

export function createTestNoticePort(initial: Notice[] = []): NoticePort & { rows: Notice[] } {
  const rows = [...initial];
  const listeners = new Set<Parameters<NoticePort["subscribeWriterVisible"]>[0]>();
  let nextId = Math.max(0, ...rows.map(({ id }) => id)) + 1;
  return {
    rows,
    async record(input) {
      const notice = { ...input, id: nextId++, createdAt: new Date() };
      rows.push(notice);
      if (!input.writerVisible || typeof input.data.documentId !== "string") return;
      for (const listener of listeners) {
        listener({
          documentId: input.data.documentId,
          kind: input.kind,
          message: input.message,
          data: input.data,
        });
      }
    },
    async drainForModelContext(threadId, activeDocumentIds) {
      const consumed = rows.filter((notice) =>
        notice.scope.kind === "thread"
          ? notice.scope.threadId === threadId
          : activeDocumentIds.includes(notice.scope.documentId),
      );
      for (const notice of consumed) rows.splice(rows.indexOf(notice), 1);
      return consumed;
    },
    async drainForWriter(documentId) {
      const consumed = rows.filter(
        (notice) => notice.writerVisible && notice.data.documentId === documentId,
      );
      for (const notice of consumed) rows.splice(rows.indexOf(notice), 1);
      return consumed;
    },
    subscribeWriterVisible(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
