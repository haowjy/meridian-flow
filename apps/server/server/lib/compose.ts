/**
 * Composition root: wires production adapters into AppServices and owns the pure
 * runtime service graph. App startup supplies process-level resources; this file
 * chooses concrete server adapters and assembles domain services behind ports.
 */
import type { Database } from "@meridian/database";
import { createStripeCustomerProvisioner } from "../domains/billing/adapters/drizzle/stripe-customer-provisioner.js";
import { createStripeBillingGateway } from "../domains/billing/adapters/stripe/stripe-gateway.js";
import {
  type BillingService,
  type BillingSpendReader,
  type BillingUsagePolicy,
  createBillingDomain,
  createDrizzleCreditLedger,
  createInMemoryCreditLedger,
} from "../domains/billing/index.js";
import {
  type CollabDomain,
  createCollabDomain,
  createInMemoryCollabDomain,
} from "../domains/collab/index.js";
import {
  createDrizzleFigureDocumentRepository,
  createDrizzleResultRepository,
  createDrizzleThreadUploadDocumentStore,
  createFigureAssetService,
  createInMemoryUnifiedContextPortFactory,
  createInterruptArtifactFlush,
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
import { createDrizzleNoticePort, type Notice, type NoticePort } from "../domains/notices/index.js";
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
  createInterruptRegistry,
  type InterruptRegistry,
} from "../domains/runtime/loop/interrupts.js";
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
  billing: BillingService;
  agents: AgentPackageStore;
  interruptRegistry: InterruptRegistry;
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
  notices: NoticePort;
};

function stripeReady(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

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
  billing: BillingService;
  billingUsage: BillingUsagePolicy;
  billingSpendReader: BillingSpendReader;
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
  notices: NoticePort;
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
  const notices = createDrizzleNoticePort(db);
  const preferences = createDrizzleProjectPreferencesRepository({ db });
  const documentSync = createCollabDomain({
    db,
    eventSink,
    notices,
    threads: threadRepos.threads,
  });
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
  const projectRepo = createDrizzleProjectRepository({ db });
  const users = createDrizzleUserRepository({ db });
  const projects = createDrizzleProjectBootstrapRepository(db);
  const workRepo = createDrizzleProjectWorkRepository({ db });
  const creditLedger = createDrizzleCreditLedger(db);
  const stripeGateway = stripeReady(environment)
    ? createStripeBillingGateway({
        secretKey: environment.STRIPE_SECRET_KEY as string,
        webhookSecret: environment.STRIPE_WEBHOOK_SECRET as string,
      })
    : null;
  const getOrCreateStripeCustomer = createStripeCustomerProvisioner({ db, stripeGateway });
  const billingDomain = createBillingDomain({
    ledger: creditLedger,
    stripeGateway,
    getOrCreateStripeCustomer,
    env: environment,
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
    billing: billingDomain.service,
    billingUsage: billingDomain.usagePolicy,
    billingSpendReader: billingDomain.spendReader,
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
    notices,
  };
}

/** Pure wiring — no env reads and no concrete adapter construction. */
export function composeAppServices(ports: ProductionAppPorts): AppServices {
  const threadEventHub = createThreadEventHub({
    journalReader: ports.journalReader,
    journalWriter: ports.journalWriter,
    eventSink: ports.eventSink,
  });
  const interruptRegistry = createInterruptRegistry();
  const toolRegistry = createToolRegistry();
  const responseWrites = createAgentEditResponseWriteLifecycle({
    documentSync: ports.documentSync,
  });
  for (const registration of createWiredCoreToolRegistrations({
    threads: ports.threadRepos.threads,
    contextPorts: ports.contextPorts,
    documentSync: ports.documentSync,
    responseWrites,
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
    billingSpendReader: ports.billingSpendReader,
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
    interruptRegistry,
    billingUsage: ports.billingUsage,
    interruptArtifacts: createInterruptArtifactFlush({
      promotion: ports.promotionService,
      objectStore: ports.objectStore,
    }),
    eventSink: ports.eventSink,
    modelRequestDebug: ports.modelRequestDebug,
    responseWrites,
    notices: ports.notices,
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
    billing: ports.billing,
    agents: ports.agents,
    interruptRegistry,
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
    notices: ports.notices,
  };
}

export function createInMemoryAppServices(): AppServices {
  const threadRepos = createInMemoryRepositories();
  const packageRepository = createInMemoryPackageStore();
  const preferences = createInMemoryProjectPreferencesRepository();
  const modelRequestDebug = createInMemoryModelRequestDebugStore();
  const notices = createInMemoryNoticePort();
  const creditLedger = createInMemoryCreditLedger();
  const billingDomain = createBillingDomain({
    ledger: creditLedger,
    stripeGateway: null,
    getOrCreateStripeCustomer: async () => {
      throw new Error("Stripe checkout is not configured");
    },
    env: {},
  });

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
    billing: billingDomain.service,
    agents: { phase: "skeleton" },
    interruptRegistry: createInterruptRegistry(),
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
      registerLiveConnectionToken() {},
      unregisterLiveConnectionToken() {},
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
      async canAccessProjectDocument() {
        return true;
      },
      async requireOwnedDocument() {},
      async projectIdForDocument() {
        return null;
      },
    },
    notices,
    modelRequestDebug,
  };
}

function createInMemoryNoticePort(): NoticePort {
  const rows: Notice[] = [];
  const listeners = new Set<Parameters<NoticePort["subscribeWriterVisible"]>[0]>();
  const deliveredDocumentScopes = new Map<number, Set<string>>();
  let nextId = 1;
  return {
    async record(input) {
      const notice: Notice = { ...input, id: nextId++, createdAt: new Date() };
      rows.push(notice);
      if (!input.writerVisible) return;
      const documentId = input.data.documentId;
      if (typeof documentId !== "string")
        throw new Error("Writer-visible notice requires data.documentId");
      for (const listener of listeners) {
        listener({ documentId, kind: input.kind, message: input.message, data: input.data });
      }
    },
    async drainForModelContext(threadId, activeDocumentIds) {
      const consumed: Notice[] = [];
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const notice = rows[index];
        if (!notice) continue;
        if (notice.scope.kind === "thread") {
          if (notice.scope.threadId !== threadId) continue;
          consumed.unshift(notice);
          if (!notice.writerVisible) rows.splice(index, 1);
          continue;
        }
        if (!activeDocumentIds.includes(notice.scope.documentId)) continue;
        const deliveries = deliveredDocumentScopes.get(notice.id) ?? new Set<string>();
        if (deliveries.has(threadId)) continue;
        deliveries.add(threadId);
        deliveredDocumentScopes.set(notice.id, deliveries);
        consumed.unshift(notice);
      }
      return consumed;
    },
    async drainForWriter(documentId) {
      const consumed: Notice[] = [];
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const notice = rows[index];
        if (!notice?.writerVisible || notice.data.documentId !== documentId) continue;
        consumed.unshift(notice);
        rows.splice(index, 1);
      }
      return consumed;
    },
    subscribeWriterVisible(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type { ThreadRepositories } from "../domains/threads/ports/index.js";
