import type { AgentPackageStore } from "../domains/agents/index.js";
import { createInMemorySubscriptionStore } from "../domains/billing/adapters/in-memory/subscription-store.js";
import { type CreditLedger, createInMemoryCreditLedger } from "../domains/billing/index.js";
import type { PaymentProvider } from "../domains/billing/ports/payment-provider.js";
import type { SubscriptionStore } from "../domains/billing/ports/subscription-store.js";
import type { DocumentSyncService } from "../domains/collab/index.js";
import type {
  ContextPortFactory,
  CorpusImportPort,
  DriveCorpusImportPort,
  FigureAssetService,
  ResultRepository,
  ThreadUploadDocumentStore,
  ThreadUploadImportService,
} from "../domains/context/index.js";
import { createNoopEventSink, type EventSink } from "../domains/observability/index.js";
import type { OnboardingService } from "../domains/onboarding/index.js";
import { createInMemoryPackageStore } from "../domains/packages/adapters/in-memory-package-store.js";
import type {
  DefaultPackageSeeder,
  MarsPackageFetcher,
  PackageRepository,
} from "../domains/packages/index.js";
import { createInMemoryProjectPreferencesRepository } from "../domains/preferences/adapters/in-memory/index.js";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import type {
  ProjectBootstrapRepository,
  ProjectRepository,
  WorkRepository as ProjectWorkRepository,
  UserRepository,
} from "../domains/projects/index.js";
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
import { createInMemoryModelRequestDebugStore } from "../domains/runtime/model-request-debug/index.js";
import type { LocalObjectStoreAdapter, ObjectStorePort } from "../domains/storage/index.js";
import { createInMemoryRepositories } from "../domains/threads/adapters/in-memory/index.js";
import type {
  EventJournalReader,
  EventJournalWriter,
  ThreadRepositories,
} from "../domains/threads/ports/index.js";
import type { ThreadRuntimeService } from "../domains/threads/runtime-service.js";
import type { ThreadEventHub } from "../domains/threads/thread-event-hub.js";
import type { DocumentAccessPort } from "./document-access.js";

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
  corpusImports: CorpusImportPort;
  driveCorpusImports: DriveCorpusImportPort;
  onboarding: OnboardingService;
  projects: ProjectBootstrapRepository;
  works: ProjectWorkRepository;
  projectRepo: ProjectRepository;
  users: UserRepository;
  workRepo: ProjectWorkRepository;
  creditLedger: CreditLedger;
  paymentProvider: PaymentProvider;
  subscriptionStore: SubscriptionStore;
  agents: AgentPackageStore;
  checkpointRegistry: CheckpointRegistry;
  eventSink: EventSink;
  packageRepository: PackageRepository;
  marsPackageFetcher: MarsPackageFetcher;
  defaultPackageSeeder: DefaultPackageSeeder;
  seedDefaultPackagesForProject(projectId: string): Promise<void>;
  preferences: ProjectPreferencesRepository;
  orchestrator: RunTurnPort;
  runner: TurnRunner;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  modelRequestDebug: ModelRequestDebugStore;
  objectStore: ObjectStorePort;
  localObjectStore: LocalObjectStoreAdapter | null;
  uploadDocuments: ThreadUploadDocumentStore;
  threadUploadImports: ThreadUploadImportService;
  figureAssets: FigureAssetService;
  results: ResultRepository;
  documentAccess: DocumentAccessPort;
};

export type ProductionAppPorts = Omit<AppServices, never>;

export function composeAppServices(ports: ProductionAppPorts): AppServices {
  return ports;
}

export function createProductionAppPorts(input: ProductionAppPorts): ProductionAppPorts {
  return input;
}

export function createInMemoryAppServices(): AppServices {
  const threadRepos = createInMemoryRepositories();
  const packageRepository = createInMemoryPackageStore();
  const preferences = createInMemoryProjectPreferencesRepository();
  const modelRequestDebug = createInMemoryModelRequestDebugStore();

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
      async *stream(request) {
        const result = await this.generate(request);
        yield { type: "start" as const, model: result.model, provider: result.provider };
        yield { type: "end" as const, result };
      },
      async generate(request) {
        return {
          content: [],
          toolCalls: [],
          finishReason: "end_turn" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: request.model ?? "in-memory",
          provider: request.provider ?? "in-memory",
        };
      },
    },
    threadRepos,
    repos: threadRepos,
    journalReader: {
      async readAfter() {
        return [];
      },
      async headSeq() {
        return 0n;
      },
      async readModelProjectionWatermark() {
        return 0n;
      },
      async listByThread() {
        return [];
      },
      async listByType() {
        return [];
      },
      async listSince() {
        return [];
      },
      async listByTimeRange() {
        return [];
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
      hasThreadState() {
        return false;
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
      hasThreadState() {
        return false;
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
      forProject() {
        throw new Error("in-memory project context port is not implemented");
      },
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
    corpusImports: {
      async importFiles() {
        throw new Error("in-memory corpus imports are not implemented");
      },
    },
    driveCorpusImports: {
      async importFixture() {
        throw new Error("in-memory drive corpus imports are not implemented");
      },
    },
    onboarding: {
      async status() {
        throw new Error("in-memory onboarding is not implemented");
      },
      async saveProgress() {
        throw new Error("in-memory onboarding is not implemented");
      },
      async complete() {
        throw new Error("in-memory onboarding is not implemented");
      },
    },
    projects: {
      async ensureDefaultBootstrap() {
        throw new Error("in-memory projects are not implemented");
      },
      async createOnboardingBootstrap() {
        throw new Error("in-memory projects are not implemented");
      },
    },
    works: {
      async create() {
        throw new Error("in-memory work repository is not implemented");
      },
      async findById() {
        throw new Error("in-memory work repository is not implemented");
      },
      async listByProject() {
        return [];
      },
      async ensureDefaultForProject() {
        throw new Error("in-memory work repository is not implemented");
      },
      async touch() {},
    },
    projectRepo: {
      async create() {
        throw new Error("in-memory project repository is not implemented");
      },
      async findById() {
        throw new Error("in-memory project repository is not implemented");
      },
      async listByUser() {
        throw new Error("in-memory project repository is not implemented");
      },
      async search() {
        throw new Error("in-memory project repository is not implemented");
      },
      async update() {
        throw new Error("in-memory project repository is not implemented");
      },
      async softDelete() {
        throw new Error("in-memory project repository is not implemented");
      },
      async restore() {
        throw new Error("in-memory project repository is not implemented");
      },
      async touch() {},
    },
    users: {
      async ensureUser() {
        throw new Error("in-memory user repository is not implemented");
      },
      async getOnboardingState() {
        return {};
      },
      async updateOnboardingState(_userId, state) {
        return state;
      },
    },
    workRepo: {
      async create() {
        throw new Error("in-memory work repository is not implemented");
      },
      async findById() {
        throw new Error("in-memory work repository is not implemented");
      },
      async listByProject() {
        throw new Error("in-memory work repository is not implemented");
      },
      async ensureDefaultForProject() {
        throw new Error("in-memory work repository is not implemented");
      },
      async touch() {},
    },
    creditLedger: createInMemoryCreditLedger(),
    subscriptionStore: createInMemorySubscriptionStore(),
    paymentProvider: {
      status() {
        return {
          mode: "fake" as const,
          needsCredentials: true,
          message: "Stripe credentials are not configured; fake checkout is active for dev/test.",
        };
      },
      async createCheckoutSession(input) {
        const id = `fake_cs_${crypto.randomUUID()}`;
        return {
          id,
          url: `${input.successUrl}?checkout=fake&session_id=${id}`,
          mode: "fake" as const,
          needsCredentials: true,
        };
      },
      async verifyWebhook(input) {
        const body = JSON.parse(input.payload || "{}");
        return {
          kind: "checkout.completed" as const,
          sessionId: String(body.sessionId ?? body.id ?? `fake_cs_${crypto.randomUUID()}`),
          userId: String(body.userId),
          projectId: typeof body.projectId === "string" ? body.projectId : null,
          entryId: String(body.entryId),
          customerId: null,
          subscriptionId: null,
          periodStart: null,
          periodEnd: null,
        };
      },
    },
    agents: { phase: "skeleton" },
    checkpointRegistry: createCheckpointRegistry(),
    eventSink: createNoopEventSink(),
    packageRepository,
    marsPackageFetcher: {
      async fetch() {
        throw new Error("in-memory Mars package fetcher is not implemented");
      },
    },
    defaultPackageSeeder: {
      async seedProject() {
        return [];
      },
    },
    async seedDefaultPackagesForProject() {},
    preferences,
    orchestrator: {
      async runTurn() {
        throw new Error("in-memory orchestrator is not implemented");
      },
    },
    runner: {
      childRunRegistry: {
        registerChild() {},
        registerBackgroundChild() {},
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
    objectStore: {
      async put() {
        throw new Error("in-memory object store is not implemented");
      },
      async get() {
        throw new Error("in-memory object store is not implemented");
      },
      async list() {
        throw new Error("in-memory object store is not implemented");
      },
      async getSignedUrl() {
        throw new Error("in-memory object store is not implemented");
      },
      async delete() {
        throw new Error("in-memory object store is not implemented");
      },
    },
    localObjectStore: null,
    uploadDocuments: {
      async transaction(operation) {
        return operation();
      },
      async createUploadDocument() {
        throw new Error("in-memory upload documents are not implemented");
      },
      async updateMarkdownProjection() {
        throw new Error("in-memory upload documents are not implemented");
      },
      async getDocument() {
        return null;
      },
      async getUpload() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listRecent() {
        return [];
      },
    },
    threadUploadImports: {
      async importUpload() {
        throw new Error("in-memory upload imports are not implemented");
      },
    },
    figureAssets: {
      async uploadFigure() {
        throw new Error("in-memory figure assets are not implemented");
      },
      async getSignedFigureUrl() {
        throw new Error("in-memory figure assets are not implemented");
      },
    },
    results: {
      async create() {
        throw new Error("in-memory results are not implemented");
      },
      async listByProject() {
        return [];
      },
    },
    documentAccess: {
      async canAccessDocument() {
        return true;
      },
    },
    modelRequestDebug,
  };
}

export type { ThreadRepositories } from "../domains/threads/ports/index.js";
