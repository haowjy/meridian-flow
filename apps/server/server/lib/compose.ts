// @ts-nocheck
import type { AgentPackageStore } from "../domains/agents/index.js";
import type { CreditLedger } from "../domains/billing/index.js";
import type { DocumentSyncService } from "../domains/collab/index.js";
import type { ContextPortFactory } from "../domains/context/index.js";
import { createNoopEventSink, type EventSink } from "../domains/observability/index.js";
import type {
  DefaultPackageSeeder,
  MarsPackageFetcher,
  PackageRepository,
} from "../domains/packages/index.js";
import type { WorkbenchPreferencesRepository } from "../domains/preferences/index.js";
import type { ProjectRepository, WorkRepository } from "../domains/projects/index.js";
import type {
  Gateway,
  RunTurnPort,
  ToolExecutor,
  ToolRegistry,
  TurnRunner,
} from "../domains/runtime/index.js";
import {
  type CheckpointRegistry,
  createCheckpointRegistry,
} from "../domains/runtime/loop/checkpoints.js";
import type { ModelRequestDebugStore } from "../domains/runtime/model-request-debug/index.js";
import type {
  EventJournalReader,
  EventJournalWriter,
  ThreadRepositories,
} from "../domains/threads/ports/index.js";
import type { ThreadRuntimeService } from "../domains/threads/runtime-service.js";
import type { ThreadEventHub } from "../domains/threads/thread-event-hub.js";
import type {
  UserRepository,
  WorkbenchRepository,
  WorkRepository as WorkbenchWorkRepository,
} from "../domains/workbenches/index.js";

export type AppServices = {
  gateway: Gateway;
  threadRepos: ThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  /** Upstream-compatible alias used by copied route/lib code. */
  repos: ThreadRepositories;
  /** Upstream-compatible alias used by copied route/lib code. */
  hub: ThreadEventHub;
  threadEventHub: ThreadEventHub;
  threadRuntime: ThreadRuntimeService;
  documentSync: DocumentSyncService;
  contextPorts: ContextPortFactory;
  projects: ProjectRepository;
  works: WorkRepository;
  workbenchRepo: WorkbenchRepository;
  users: UserRepository;
  workRepo: WorkbenchWorkRepository;
  creditLedger: CreditLedger;
  agents: AgentPackageStore;
  checkpointRegistry: CheckpointRegistry;
  eventSink: EventSink;
  packageRepository: PackageRepository;
  marsPackageFetcher: MarsPackageFetcher;
  defaultPackageSeeder: DefaultPackageSeeder;
  seedDefaultPackagesForWorkbench(workbenchId: string): Promise<void>;
  preferences: WorkbenchPreferencesRepository;
  orchestrator: RunTurnPort;
  runner: TurnRunner;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  modelRequestDebug: ModelRequestDebugStore;
};

export type ProductionAppPorts = Omit<AppServices, never>;

export function composeAppServices(ports: ProductionAppPorts): AppServices {
  return ports;
}

export function createProductionAppPorts(input: ProductionAppPorts): ProductionAppPorts {
  return input;
}

export function createInMemoryAppServices(): AppServices {
  const documentSync: DocumentSyncService = {
    async writeDocument() {
      throw new Error("in-memory document sync is not implemented");
    },
    async editDocument() {
      throw new Error("in-memory document sync is not implemented");
    },
    async requireOwnedDocument() {
      throw new Error("in-memory document sync is not implemented");
    },
    async initializeMirror() {
      throw new Error("in-memory document sync is not implemented");
    },
    async getLastUpdateAttribution() {
      throw new Error("in-memory document sync is not implemented");
    },
    async applyEditorUpdate() {
      throw new Error("in-memory document sync is not implemented");
    },
    forgetMirror() {
      throw new Error("in-memory document sync is not implemented");
    },
    async getOrCreateMirror() {
      throw new Error("in-memory document sync is not implemented");
    },
    async readAsMarkdown() {
      throw new Error("in-memory document sync is not implemented");
    },
    async editFromMarkdown() {
      throw new Error("in-memory document sync is not implemented");
    },
    async writeFromMarkdown() {
      throw new Error("in-memory document sync is not implemented");
    },
    async checkpoint() {
      throw new Error("in-memory document sync is not implemented");
    },
    async restore() {
      throw new Error("in-memory document sync is not implemented");
    },
    async listCheckpoints() {
      throw new Error("in-memory document sync is not implemented");
    },
    async getDoc() {
      throw new Error("in-memory document sync is not implemented");
    },
    async applyUpdate() {
      throw new Error("in-memory document sync is not implemented");
    },
    async encodeState() {
      throw new Error("in-memory document sync is not implemented");
    },
  };

  return {
    gateway: {
      async generateAssistantText(input) {
        return `Acknowledged: ${input.userText}`;
      },
      async generateTurnPlan(input) {
        return {
          assistantText: `Acknowledged: ${input.userText}`,
          actions: [],
        };
      },
    },
    threadRepos: { phase: "phase3" },
    repos: { phase: "phase3" },
    journalReader: {
      async readAfter() {
        return [];
      },
      async headSeq() {
        return "0";
      },
    },
    journalWriter: {
      async appendEvent() {
        return 1n;
      },
    },
    threadEventHub: {
      publishPersistedEvent() {},
      async appendEvent() {
        return 0n;
      },
      async catchup() {
        return [];
      },
      subscribe() {
        return () => undefined;
      },
      async catchupAndSubscribe() {
        return { catchup: [], hitReplayLimit: false, unsubscribe: () => undefined };
      },
      async headSeq() {
        return 0n;
      },
      journalSeqForEventSeq(seq: bigint) {
        return seq / 1000n;
      },
      async readModelProjectionWatermark() {
        return 0n;
      },
    },
    hub: {
      publishPersistedEvent() {},
      async appendEvent() {
        return 0n;
      },
      async catchup() {
        return [];
      },
      subscribe() {
        return () => undefined;
      },
      async catchupAndSubscribe() {
        return { catchup: [], hitReplayLimit: false, unsubscribe: () => undefined };
      },
      async headSeq() {
        return 0n;
      },
      journalSeqForEventSeq(seq: bigint) {
        return seq / 1000n;
      },
      async readModelProjectionWatermark() {
        return 0n;
      },
    },
    threadRuntime: {
      async requireOwnedThread() {
        throw new Error("in-memory thread runtime is not implemented");
      },
      async liveState() {
        throw new Error("in-memory thread runtime is not implemented");
      },
      async sendMessage() {
        throw new Error("in-memory thread runtime is not implemented");
      },
      async journalEvents() {
        return [];
      },
    },
    documentSync,
    contextPorts: {
      forThread() {
        return {
          async readDocument() {
            throw new Error("in-memory context port is not implemented");
          },
          async writeDocument() {
            throw new Error("in-memory context port is not implemented");
          },
          async editDocument() {
            throw new Error("in-memory context port is not implemented");
          },
        };
      },
    },
    projects: {
      async ensureDefaultBootstrap() {
        throw new Error("in-memory projects are not implemented");
      },
    },
    works: { phase: "phase4" },
    workbenchRepo: {
      async create() {
        throw new Error("in-memory workbench repository is not implemented");
      },
      async findById() {
        throw new Error("in-memory workbench repository is not implemented");
      },
      async listByUser() {
        throw new Error("in-memory workbench repository is not implemented");
      },
      async search() {
        throw new Error("in-memory workbench repository is not implemented");
      },
      async update() {
        throw new Error("in-memory workbench repository is not implemented");
      },
      async softDelete() {
        throw new Error("in-memory workbench repository is not implemented");
      },
      async restore() {
        throw new Error("in-memory workbench repository is not implemented");
      },
      async touch() {},
    },
    users: {
      async ensureUser() {
        throw new Error("in-memory user repository is not implemented");
      },
    },
    workRepo: {
      async create() {
        throw new Error("in-memory work repository is not implemented");
      },
      async findById() {
        throw new Error("in-memory work repository is not implemented");
      },
      async listByWorkbench() {
        throw new Error("in-memory work repository is not implemented");
      },
      async ensureDefaultForWorkbench() {
        throw new Error("in-memory work repository is not implemented");
      },
      async touch() {},
    },
    creditLedger: { phase: "skeleton" },
    agents: { phase: "skeleton" },
    checkpointRegistry: createCheckpointRegistry(),
    eventSink: createNoopEventSink(),
    packageRepository: { phase: "skeleton" },
    marsPackageFetcher: {
      async fetch() {
        throw new Error("in-memory Mars package fetcher is not implemented");
      },
    },
    defaultPackageSeeder: {
      async seedWorkbench() {
        return [];
      },
    },
    async seedDefaultPackagesForWorkbench() {},
    preferences: { phase: "skeleton" },
    orchestrator: {
      async runTurn() {
        throw new Error("in-memory orchestrator is not implemented");
      },
    },
    runner: {
      childRunRegistry: {
        registerChild() {},
        unregisterChild() {},
        abortChild() {},
        abortChildrenOf() {},
      },
      getRunningTurnId() {
        return null;
      },
      async startTurn() {
        throw new Error("in-memory turn runner is not implemented");
      },
      async cancel() {
        return "not_found" as const;
      },
    },
    toolRegistry: {
      getDefinitions() {
        return [];
      },
      getRegistration() {
        return undefined;
      },
      register() {},
    },
    toolExecutor: {
      async executeTool() {
        throw new Error("in-memory tool executor is not implemented");
      },
    },
    modelRequestDebug: {
      record() {},
      list() {
        return [];
      },
    },
  };
}

export type { ThreadRepositories } from "../domains/threads/ports/index.js";
