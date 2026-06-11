import type { AgentPackageStore } from "../domains/agents/index.js";
import type { CreditLedger } from "../domains/billing/index.js";
import type { DocumentSyncService } from "../domains/collab/index.js";
import type { ContextPortFactory } from "../domains/context/index.js";
import type { ProjectRepository, WorkRepository } from "../domains/projects/index.js";
import type { Gateway } from "../domains/runtime/index.js";
import type {
  EventJournalReader,
  EventJournalWriter,
  ThreadEventHub,
  ThreadRepositories,
  ThreadRuntimeService,
} from "../domains/threads/index.js";

export type AppServices = {
  gateway: Gateway;
  threadRepos: ThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  threadEventHub: ThreadEventHub;
  threadRuntime: ThreadRuntimeService;
  documentSync: DocumentSyncService;
  contextPorts: ContextPortFactory;
  projects: ProjectRepository;
  works: WorkRepository;
  creditLedger: CreditLedger;
  agents: AgentPackageStore;
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
    subscribe() {
      return () => undefined;
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
    creditLedger: { phase: "skeleton" },
    agents: { phase: "skeleton" },
  };
}

export type { ThreadRepositories };
