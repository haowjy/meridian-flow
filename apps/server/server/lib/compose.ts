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
} from "../domains/threads/index.js";

export type AppServices = {
  gateway: Gateway;
  threadRepos: ThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  threadEventHub: ThreadEventHub;
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
  return {
    gateway: { phase: "skeleton" },
    threadRepos: { phase: "skeleton" },
    journalReader: {
      async headSeq() {
        return "0";
      },
    },
    journalWriter: {
      async append() {
        return "1";
      },
    },
    threadEventHub: { phase: "skeleton" },
    documentSync: { phase: "skeleton" },
    contextPorts: {
      forThread() {
        return { phase: "skeleton" };
      },
    },
    projects: { phase: "skeleton" },
    works: { phase: "skeleton" },
    creditLedger: { phase: "skeleton" },
    agents: { phase: "skeleton" },
  };
}

export type { ThreadRepositories };
