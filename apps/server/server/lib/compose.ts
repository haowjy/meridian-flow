/**
 * Composition root: wires production adapters into AppServices and owns the pure
 * runtime service graph. App startup supplies process-level resources; this file
 * chooses concrete server adapters and assembles domain services behind ports.
 */
import type { Database } from "@meridian/database";
import { createDrizzleSubscriptionStore } from "../domains/billing/adapters/drizzle/subscription-store.js";
import { createInMemorySubscriptionStore } from "../domains/billing/adapters/in-memory/subscription-store.js";
import {
  type CreditLedger,
  createDrizzleCreditLedger,
  createFreeGrantPipeline,
  createGrantingCreditLedger,
  createInMemoryCreditLedger,
} from "../domains/billing/index.js";
import { createPaymentProviderFromEnv } from "../domains/billing/payment-provider-factory.js";
import type { PaymentProvider } from "../domains/billing/ports/payment-provider.js";
import type { SubscriptionStore } from "../domains/billing/ports/subscription-store.js";
import {
  type CollabDomain,
  createCollabDomain,
  createInMemoryCollabDomain,
} from "../domains/collab/index.js";
import {
  createCheckpointArtifactFlush,
  createDrizzleFigureDocumentRepository,
  createDrizzleResultRepository,
  createDrizzleThreadUploadDocumentStore,
  createFigureAssetService,
  createInMemoryUnifiedContextPortFactory,
  createProductionUnifiedContextPortFactory,
  createPromotionService,
  createThreadUploadImportService,
  type FigureAssetService,
  type PromotionService,
  type ResultRepository,
  type ThreadUploadDocumentStore,
  type ThreadUploadImportService,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";
import { createNoopEventSink, type EventSink, emitEvent } from "../domains/observability/index.js";
import { createInMemoryPackageStore } from "../domains/packages/adapters/in-memory-package-store.js";
import {
  createDefaultPackageSeeder,
  createDrizzlePackageStore,
  createGitHubMarsPackageFetcher,
  type DefaultPackageSeeder,
  defaultPackageSeedConfigFromEnv,
  type MarsPackageFetcher,
  type PackageRepository,
} from "../domains/packages/index.js";
import { createInMemoryProjectPreferencesRepository } from "../domains/preferences/adapters/in-memory/project-preferences-repository.js";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import { createDrizzleProjectPreferencesRepository } from "../domains/preferences/index.js";
import {
  createDrizzleProjectBootstrapRepository,
  createDrizzleProjectRepository,
  createDrizzleProjectWorkRepository,
  createDrizzleUserRepository,
  type ProjectBootstrapRepository,
  type ProjectRepository,
  type WorkRepository as ProjectWorkRepository,
  type UserRepository,
} from "../domains/projects/index.js";
import {
  computeEffectivePermissions,
  createChildRunCoordinator,
  createGatewayFromEnv,
  createHelperResultDelivery,
  createInvokeToolRegistration,
  createLateBindRunTurnPort,
  createOrchestrator,
  createPermissionGate,
  createSpawnToolRegistrations,
  createToolExecutor,
  createToolRegistry,
  createTurnRunner,
  type Gateway,
  type RunTurnPort,
  resolveProfile,
  type ToolExecutor,
  type ToolRegistry,
  type TurnRunner,
} from "../domains/runtime/index.js";
import {
  type CheckpointRegistry,
  createCheckpointRegistry,
} from "../domains/runtime/loop/checkpoints.js";
import type { ModelRequestDebugStore } from "../domains/runtime/model-request-debug/index.js";
import {
  createInMemoryModelRequestDebugStore,
  createModelRequestDebugStoreFromEnv,
} from "../domains/runtime/model-request-debug/index.js";
import {
  createRuntimeToolRegistry,
  type RuntimeToolRegistry,
} from "../domains/runtime/tool-registry.js";
import type { LocalObjectStoreAdapter, ObjectStorePort } from "../domains/storage/index.js";
import { createDrizzleEventJournalReader } from "../domains/threads/adapters/drizzle/event-reader.js";
import { createDrizzleEventJournalWriter } from "../domains/threads/adapters/drizzle/event-writer.js";
import { createDrizzleRepositories } from "../domains/threads/adapters/drizzle/index.js";
import { createInMemoryRepositories } from "../domains/threads/adapters/in-memory/index.js";
import type {
  EventJournalReader,
  EventJournalWriter,
  InternalThreadRepositories,
  ThreadRepositories,
} from "../domains/threads/ports/index.js";
import {
  createThreadRuntimeService,
  type ThreadRuntimeService,
} from "../domains/threads/runtime-service.js";
import { createThreadEventHub, type ThreadEventHub } from "../domains/threads/thread-event-hub.js";
import { createDrizzleDocumentAccess, type DocumentAccessPort } from "./document-access.js";
import { createObjectStoreFromEnv } from "./object-store-factory.js";
import {
  createAgentEditResponseWriteLifecycle,
  createWiredCoreToolRegistrations,
} from "./wired-core-tools.js";

type AgentPackageStore = { readonly phase: "skeleton" };

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
  documentSync: CollabDomain;
  contextPorts: UnifiedContextPortFactory;
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

export type ProductionAppPorts = {
  db: Database;
  gateway: Gateway;
  threadRepos: InternalThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  eventSink: EventSink;
  documentSync: CollabDomain;
  contextPorts: UnifiedContextPortFactory;
  runtimeTools: RuntimeToolRegistry;
  projects: ProjectBootstrapRepository;
  works: ProjectWorkRepository;
  projectRepo: ProjectRepository;
  users: UserRepository;
  workRepo: ProjectWorkRepository;
  creditLedger: CreditLedger;
  paymentProvider: PaymentProvider;
  subscriptionStore: SubscriptionStore;
  agents: AgentPackageStore;
  packageRepository: PackageRepository;
  marsPackageFetcher: MarsPackageFetcher;
  defaultPackageSeeder: DefaultPackageSeeder;
  preferences: ProjectPreferencesRepository;
  modelRequestDebug: ModelRequestDebugStore;
  objectStore: ObjectStorePort;
  localObjectStore: LocalObjectStoreAdapter | null;
  uploadDocuments: ThreadUploadDocumentStore;
  threadUploadImports: ThreadUploadImportService;
  figureAssets: FigureAssetService;
  results: ResultRepository;
  promotionService: PromotionService;
  documentAccess: DocumentAccessPort;
};

export async function createProductionAppPorts(input: {
  db: Database;
  eventSink: EventSink;
  environment?: NodeJS.ProcessEnv;
}): Promise<ProductionAppPorts> {
  const environment = input.environment ?? process.env;
  const eventSink = input.eventSink;
  const { gateway } = await createGatewayFromEnv(environment, {
    onInfo: (info) => {
      emitEvent(eventSink, {
        level: "info",
        source: "gateway",
        name: "gateway.resolved",
        payload: {
          message: info.message,
          provider: info.provider,
          model: info.model ?? null,
        },
      });
    },
    onWarning: (span) => {
      emitEvent(eventSink, {
        level: "warn",
        source: "gateway",
        name: span.name,
        payload: span.attributes ?? {},
      });
    },
  });
  const db = input.db;
  const threadRepos = createDrizzleRepositories(db);
  const journalReader = createDrizzleEventJournalReader(db);
  const journalWriter = createDrizzleEventJournalWriter(db);
  const { objectStore, localObjectStore } = createObjectStoreFromEnv();
  const documentAccess = createDrizzleDocumentAccess(db);
  const documentSync = createCollabDomain({ db, eventSink });
  const uploadDocuments = createDrizzleThreadUploadDocumentStore(db, threadRepos.threadDocuments);
  const threadUploadImports = createThreadUploadImportService({
    repos: threadRepos,
    uploadDocuments,
    documentSync,
    objectStore,
    eventSink,
  });
  const figureAssets = createFigureAssetService({
    objectStore,
    documents: createDrizzleFigureDocumentRepository({ db }),
    signedUrlExpiresAt: () => new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    eventSink,
  });
  const results = createDrizzleResultRepository(db);
  const promotionService = createPromotionService({ objectStore, results });
  const contextPorts = createProductionUnifiedContextPortFactory({ db, documentSync });
  const runtimeTools = createRuntimeToolRegistry({
    db,
    contextPorts,
    threads: threadRepos.threads,
    threadWorks: threadRepos.threadWorks,
  });
  const packageRepository = createDrizzlePackageStore({ db });
  const marsPackageFetcher = createGitHubMarsPackageFetcher({
    githubToken: environment.GITHUB_TOKEN,
  });
  const defaultPackageSeeder = createDefaultPackageSeeder({
    repository: packageRepository,
    fetcher: marsPackageFetcher,
    config: defaultPackageSeedConfigFromEnv(environment),
  });
  const preferences = createDrizzleProjectPreferencesRepository({ db });
  const projectRepo = createDrizzleProjectRepository({ db });
  const users = createDrizzleUserRepository({ db });
  const projects = createDrizzleProjectBootstrapRepository(db);
  const workRepo = createDrizzleProjectWorkRepository({ db });
  const baseCreditLedger = createDrizzleCreditLedger(db);
  const creditLedger = createGrantingCreditLedger({
    ledger: baseCreditLedger,
    grants: createFreeGrantPipeline({ ledger: baseCreditLedger }),
  });

  return {
    db,
    gateway,
    threadRepos,
    journalReader,
    journalWriter,
    eventSink,
    documentSync,
    contextPorts,
    runtimeTools,
    projects,
    works: workRepo,
    projectRepo,
    users,
    workRepo,
    creditLedger,
    paymentProvider: createPaymentProviderFromEnv(environment),
    subscriptionStore: createDrizzleSubscriptionStore(db),
    agents: { phase: "skeleton" },
    packageRepository,
    marsPackageFetcher,
    defaultPackageSeeder,
    preferences,
    modelRequestDebug: createModelRequestDebugStoreFromEnv(),
    objectStore,
    localObjectStore,
    uploadDocuments,
    threadUploadImports,
    figureAssets,
    results,
    promotionService,
    documentAccess,
  };
}

/** Pure wiring — no env reads and no concrete adapter construction. */
export function composeAppServices(ports: ProductionAppPorts): AppServices {
  const threadEventHub = createThreadEventHub({
    journalReader: ports.journalReader,
    journalWriter: ports.journalWriter,
    eventSink: ports.eventSink,
  });
  const checkpointRegistry = createCheckpointRegistry();
  const toolRegistry = createToolRegistry();
  for (const registration of createWiredCoreToolRegistrations({
    threads: ports.threadRepos.threads,
    contextPorts: ports.contextPorts,
    documentSync: ports.documentSync,
    threadWorks: ports.threadRepos.threadWorks,
    documentTouches: ports.threadRepos.documentTouches,
    eventSink: ports.eventSink,
  })) {
    toolRegistry.register(registration);
  }
  toolRegistry.register(
    createInvokeToolRegistration({
      packageRepository: ports.packageRepository,
      async findThreadById(threadId: string) {
        const thread = await ports.threadRepos.threads.findById(threadId);
        return thread
          ? {
              projectId: thread.projectId,
              userId: thread.userId,
              currentAgent: thread.currentAgent,
              bakedSkillSlugs: thread.bakedSkillSlugs ?? null,
            }
          : null;
      },
    }),
  );
  for (const registration of createSpawnToolRegistrations()) {
    toolRegistry.register(registration);
  }
  const toolExecutor = createToolExecutor(toolRegistry);
  const runTurnProxy = createLateBindRunTurnPort();
  let helperResultDelivery: ReturnType<typeof createHelperResultDelivery> | undefined;
  const runner = createTurnRunner({
    orchestrator: runTurnProxy,
    hub: threadEventHub,
    repos: { turns: ports.threadRepos.turns },
    eventSink: ports.eventSink,
    helperResultDelivery: {
      async flush(threadId) {
        await helperResultDelivery?.flush(threadId);
      },
    },
  });
  helperResultDelivery = createHelperResultDelivery({
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    getRunningTurnId: (threadId) => runner.getRunningTurnId(threadId),
  });
  const childRunCoordinator = createChildRunCoordinator({
    orchestrator: runTurnProxy,
    repos: {
      threads: ports.threadRepos.threads,
      subagentThreads: ports.threadRepos.threads,
      turns: ports.threadRepos.turns,
      blocks: ports.threadRepos.blocks,
      transaction: ports.threadRepos.transaction,
      threadWorks: ports.threadRepos.threadWorks,
    },
    resolveWorkMembership: async (input) => {
      const { resolveWorkMembership } = await import("./work-attachment.js");
      return resolveWorkMembership(
        {
          workRepo: ports.workRepo,
          threadWorks: ports.threadRepos.threadWorks,
          threads: ports.threadRepos.threads,
        },
        input,
      );
    },
    eventWriter: threadEventHub,
    packageRepository: ports.packageRepository,
    childRunRegistry: runner.childRunRegistry,
    helperResultDelivery,
    creditLedger: ports.creditLedger,
  });
  const orchestrator = createOrchestrator({
    gateway: ports.gateway,
    toolExecutor,
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    packageRepository: ports.packageRepository,
    toolRegistry,
    projectPreferences: ports.preferences,
    permissionGate: createPermissionGate(computeEffectivePermissions(resolveProfile("coding"))),
    childRunCoordinator,
    helperResultDelivery,
    checkpointRegistry,
    creditLedger: ports.creditLedger,
    checkpointArtifacts: createCheckpointArtifactFlush({
      promotion: ports.promotionService,
      objectStore: ports.objectStore,
    }),
    eventSink: ports.eventSink,
    modelRequestDebug: ports.modelRequestDebug,
    responseWrites: createAgentEditResponseWriteLifecycle({
      documentSync: ports.documentSync,
      eventSink: ports.eventSink,
    }),
  });
  runTurnProxy.bind(orchestrator);

  return {
    gateway: ports.gateway,
    threadRepos: ports.threadRepos,
    repos: ports.threadRepos,
    journalReader: ports.journalReader,
    journalWriter: ports.journalWriter,
    threadEventHub,
    hub: threadEventHub,
    threadRuntime: createThreadRuntimeService({
      db: ports.db,
      gateway: ports.gateway,
      hub: threadEventHub,
      tools: ports.runtimeTools,
    }),
    documentSync: ports.documentSync,
    contextPorts: ports.contextPorts,
    projects: ports.projects,
    works: ports.works,
    projectRepo: ports.projectRepo,
    users: ports.users,
    workRepo: ports.workRepo,
    creditLedger: ports.creditLedger,
    paymentProvider: ports.paymentProvider,
    subscriptionStore: ports.subscriptionStore,
    agents: ports.agents,
    checkpointRegistry,
    eventSink: ports.eventSink,
    packageRepository: ports.packageRepository,
    marsPackageFetcher: ports.marsPackageFetcher,
    defaultPackageSeeder: ports.defaultPackageSeeder,
    seedDefaultPackagesForProject: async (projectId) => {
      await ports.defaultPackageSeeder.seedProject(projectId);
    },
    preferences: ports.preferences,
    orchestrator,
    runner,
    toolRegistry,
    toolExecutor,
    modelRequestDebug: ports.modelRequestDebug,
    objectStore: ports.objectStore,
    localObjectStore: ports.localObjectStore,
    uploadDocuments: ports.uploadDocuments,
    threadUploadImports: ports.threadUploadImports,
    figureAssets: ports.figureAssets,
    results: ports.results,
    documentAccess: ports.documentAccess,
  };
}

export function createInMemoryAppServices(): AppServices {
  const threadRepos = createInMemoryRepositories();
  const packageRepository = createInMemoryPackageStore();
  const preferences = createInMemoryProjectPreferencesRepository();
  const modelRequestDebug = createInMemoryModelRequestDebugStore();

  const documentSync: CollabDomain = createInMemoryCollabDomain();

  const inMemoryThreadEventHub: ThreadEventHub = {
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
      getDefaultModel() {
        return undefined;
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
    threadEventHub: inMemoryThreadEventHub,
    hub: inMemoryThreadEventHub,
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
    contextPorts: createInMemoryUnifiedContextPortFactory({ documentSync }),
    projects: {
      async findPersonalProjectId() {
        return null;
      },
      async ensureDefaultBootstrap() {
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
      async getLastActiveProjectId() {
        return null;
      },
      async setLastActiveProjectId() {},
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
      finalizeGeneratorFailure: async () => {},
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
      getRunningConnectionToken() {
        return undefined;
      },
      registerLiveConnectionToken() {},
      unregisterLiveConnectionToken() {},
      cancelTurnsOwnedByConnectionToken() {},
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
      async requireOwnedDocument() {},
    },
    modelRequestDebug,
  };
}

export type { ThreadRepositories } from "../domains/threads/ports/index.js";
