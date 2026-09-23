/**
 * Test orchestrator dependency factory: assembles the now-required runtime
 * ports with in-memory or noop adapters so each test overrides only the seam it
 * exercises. Required runtime dependencies stay visible without repeating the
 * whole DI graph in every fixture.
 */

import type { ProjectPreferences } from "@meridian/contracts/preferences";
import { testWorkSlug } from "../../../../test-support/work-slug.js";
import {
  type CreditLedger,
  createBillingUsagePolicy,
  createInMemoryCreditLedger,
} from "../../../billing/index.js";
import type { Notice, NoticePort } from "../../../notices/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import {
  type AgentRevisionStore,
  createInMemoryAccountSkillInstallStore,
} from "../../../packages/index.js";
import { createInMemoryProjectPreferencesRepository } from "../../../preferences/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createActiveDocumentResolver,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryThreadLock,
} from "../../adapters/in-memory/loop-ports.js";
import type { Gateway } from "../../gateway/index.js";
import { createInMemoryModelRequestDebugStore } from "../../model-request-debug/index.js";
import type { ChildRunCoordinator } from "../../spawn/child-run-coordinator.js";
import { createToolRegistry, type ToolExecutor } from "../../tools/index.js";
import { createNoopInterruptArtifactFlushPort } from "../interrupt-session.js";
import { createInterruptRegistry } from "../interrupts.js";
import type { OrchestratorDeps } from "../orchestrator.js";
import { createInertGateway } from "./test-gateway.js";

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
    async runChild() {
      throw new Error("Test child run coordinator not configured");
    },
  };
}

/** Loop fixtures name their bound threads; newly created children remain unbound. */
export function createTestAgentBinding(
  model: string,
  systemPrompt = "",
  boundThreads: () => readonly string[] = () => [],
): Pick<
  AgentRevisionStore,
  "readThreadBinding" | "listInstallations" | "readSource" | "readRevision"
> {
  return {
    async readThreadBinding(threadId) {
      if (!boundThreads().includes(threadId)) return undefined;
      return {
        revision: {
          id: "fixture-definition",
          packageRevisionId: "fixture-source",
          slug: "general",
          definitionDigest: "fixture-digest",
          definition: {
            schemaVersion: 1,
            systemPrompt,
            metadata: { model },
          },
        },
        configuration: { model, skills: { load: [], available: [] }, namedTargets: [] },
        invocationOverlay: null,
      };
    },
    async listInstallations() {
      return [];
    },
    async readSource() {
      return undefined;
    },
    async readRevision() {
      return undefined;
    },
  };
}

export function createTestOrchestratorDeps(
  overrides: Partial<OrchestratorDeps> & {
    creditLedger?: CreditLedger;
    boundThreads?: () => readonly string[];
  } = {},
): OrchestratorDeps & { creditLedger: CreditLedger } {
  const { boundThreads, ...dependencies } = overrides;
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const activeDocuments = createActiveDocumentResolver(repos);
  const preferences = createInMemoryProjectPreferencesRepository();
  const projectPreferences = {
    async read(userId: string, projectId: string): Promise<ProjectPreferences> {
      return preferences.read(userId, projectId);
    },
  };

  const creditLedger = overrides.creditLedger ?? createInMemoryCreditLedger();
  const gateway = overrides.gateway ?? inertGateway();

  return {
    gateway,
    toolExecutor: inertToolExecutor(),
    referenceReader: {
      async read() {
        throw new Error("Reference reader not configured");
      },
    },
    repos,
    eventWriter: createInMemoryEventJournalWriter(),
    agentRevisions: createTestAgentBinding(
      gateway.getDefaultModel?.() ?? "stub-model",
      "",
      boundThreads,
    ),
    accountSkillInstalls: createInMemoryAccountSkillInstallStore(),
    toolRegistry: createToolRegistry(),
    projectPreferences,
    workWriteMode: {
      async read() {
        return "direct";
      },
    },
    billingUsage: overrides.billingUsage ?? createBillingUsagePolicy(creditLedger),
    interruptArtifacts: createNoopInterruptArtifactFlushPort(),
    childRunCoordinator: noopChildRunCoordinator(),
    interruptRegistry: createInterruptRegistry(),
    eventSink: createInMemoryEventSink(),
    modelRequestDebug: createInMemoryModelRequestDebugStore(),
    notices: createTestNoticePort(),
    inbox: createInMemoryInbox(),
    threadLock: createInMemoryThreadLock(),
    runAuthority: createInMemoryRunAuthority(),
    activeDocuments,
    imageAssets: overrides.imageAssets ?? {
      async resolve() {
        return null;
      },
    },
    workContextDelivery: overrides.workContextDelivery ?? {
      async deliverNow() {
        throw new Error("No Work-context delivery expected");
      },
    },
    responseWrites: {
      async commitResponse() {
        return { status: "committed", receipts: [], concurrentEdits: [] };
      },
      async rollbackResponse() {},
    },
    ...dependencies,
    workContext: overrides.workContext ?? {
      async renderForThread() {
        return {
          text: "<work_context>\ntest\n</work_context>",
          current: {
            projectId: "00000000-0000-0000-0000-000000000001",
            execution: {
              scope: {
                workId: "00000000-0000-0000-0000-000000000002",
                workSlug: testWorkSlug("test-work"),
              },
              aiWriteMode: "direct",
              draftOwner: null,
            },
          },
        };
      },
    },
    creditLedger,
  };
}

export function createTestNoticePort(initial: Notice[] = []): NoticePort & { rows: Notice[] } {
  const rows = [...initial];
  let nextId = Math.max(0, ...rows.map(({ id }) => id)) + 1;
  return {
    rows,
    async record(input) {
      const notice = { ...input, id: nextId++, createdAt: new Date() };
      rows.push(notice);
    },
    async drainForModelContext(threadId) {
      const consumed = rows.filter((notice) => notice.scope.threadId === threadId);
      for (const notice of consumed) rows.splice(rows.indexOf(notice), 1);
      return consumed;
    },
  };
}
