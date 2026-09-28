/**
 * Composition root: wires production adapters into AppServices and owns the pure
 * runtime service graph. App startup supplies process-level resources; this file
 * chooses concrete server adapters and assembles domain services behind ports.
 */

import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
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
import { createChangeTrailWorker } from "../domains/collab/adapters/change-trail-worker.js";
import { createDrizzleChangeTrailReader } from "../domains/collab/adapters/drizzle-change-trail-reader.js";
import {
  type CollabDomain,
  createCollabDomain,
  createInMemoryCollabDomain,
} from "../domains/collab/index.js";
import {
  type ContextCatalog,
  type ContextCatalogWakeHub,
  createContextCatalogWakeHub,
  createContextUploadContentPort,
  createDocumentAddressResolver,
  createDocumentLinkResolver,
  createDocumentRevisions,
  createDrizzleAssetPathResolver,
  createDrizzleContextCatalog,
  createDrizzleDocumentAddressStore,
  createDrizzleFigureDocumentRepository,
  createDrizzleProjectContextAvailability,
  createDrizzleResultRepository,
  createDrizzleUploadIdentityPort,
  createDrizzleUploadIntakeRepository,
  createFigureAssetService,
  createInMemoryUnifiedContextPortFactory,
  createInterruptArtifactFlush,
  createProductionUnifiedContextPortFactory,
  createPromotionService,
  createUploadIntake,
  type DocumentAddressResolver,
  type DocumentLinkResolver,
  type FigureAssetService,
  InMemoryContextCatalog,
  type ProjectContextAvailabilityPort,
  type PromotionService,
  type ResultRepository,
  type UnifiedContextPortFactory,
  type UploadIdentityPort,
  type UploadIntake,
} from "../domains/context/index.js";
import { createDrizzleNoticePort, type Notice, type NoticePort } from "../domains/notices/index.js";
import {
  createNoopEventSink,
  type EventQuery,
  type EventSink,
  emitEvent,
} from "../domains/observability/index.js";
import {
  type AccountSkillInstallStore,
  type AgentRevisionStore,
  type BoundAgentCatalog,
  createBoundAgentCatalog,
  createDrizzleAccountSkillInstallStore,
  createDrizzleAgentRevisionStore,
  createGitHubMarsPackageFetcher,
  createInMemoryAccountSkillInstallStore,
  createInMemoryAgentRevisionStore,
  defaultPackageSeedConfigFromEnv,
  type MarsPackageFetcher,
  seedDefaultAgentPackages,
  seedGeneralAgent,
} from "../domains/packages/index.js";
import { createInMemoryProjectPreferencesRepository } from "../domains/preferences/adapters/in-memory/project-preferences-repository.js";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import { createDrizzleProjectPreferencesRepository } from "../domains/preferences/index.js";
import {
  createDrizzleProjectBootstrapRepository,
  createDrizzleProjectRepository,
  createDrizzleProjectWorkAuthorityResolver,
  createDrizzleProjectWorkRepository,
  createDrizzleUserRepository,
  createWorkProjectionMutation,
  type ProjectBootstrapRepository,
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  type WorkRepository as ProjectWorkRepository,
  type UserRepository,
} from "../domains/projects/index.js";
import {
  createDrizzleRecentDocumentsRepository,
  createInMemoryRecentDocumentsRepository,
  type RecentDocumentsRepository,
} from "../domains/recent-documents/index.js";
import {
  agentExecutionUnavailableReasons,
  agentModelUnavailableReasons,
} from "../domains/runtime/agent-definition-support.js";
import { MODEL_REGISTRY, type MockScriptQueue } from "../domains/runtime/gateway/index.js";
import { generateHandoffBrief } from "../domains/runtime/handoff/brief-request.js";
import {
  createHandoffBriefs,
  type HandoffBriefs,
} from "../domains/runtime/handoff/brief-service.js";
import {
  createChildRunCoordinator,
  createChildRunDriver,
  createCompactionUndoReader,
  createContextImageAssetPort,
  createConversationSummarizer,
  createDrizzleAdmissionRecords,
  createDrizzleHandoffBriefClaim,
  createDrizzleHandoffStatusReader,
  createDrizzleRunClaim,
  createDrizzleRuntimeDelivery,
  createDrizzleThreadLock,
  createGatewayFromEnv,
  createInMemoryInbox,
  createInMemoryRunClaim,
  createInMemoryRunStarter,
  createInMemoryRuntimeDelivery,
  createInMemoryThreadLock,
  createInspectionToolRegistrations,
  createInstrumentedGateway,
  createOrchestrator,
  createOrphanReportRepair,
  createPrefixCacheStateService,
  createReportPublisher,
  createRunStarter,
  createSkillToolRegistrations,
  createSpawnToolRegistrations,
  createSubagentActivityRefresher,
  createToolExecutor,
  createToolRegistry,
  createUserTurnAdmission,
  createWorkContextReader,
  createWriterTurnProducer,
  type DeliveryProducer,
  type Gateway,
  InvalidAdmissionError,
  type RunClaim,
  type RunStarter,
  type RunTurnPort,
  readPendingInbox,
  sweepWakes,
  type ToolExecutor,
  type ToolRegistry,
  type TurnRunner,
  type UserTurnAdmission,
  type WorkContextNotices,
  type WorkContextReader,
} from "../domains/runtime/index.js";
import {
  loadModelSkillBody,
  resolveThreadUserInvocableSkills,
  SkillUnavailableError,
  unavailableActivatedSkillSlugs,
} from "../domains/runtime/loop/available-skills.js";
import {
  createInterruptRegistry,
  type InterruptRegistry,
} from "../domains/runtime/loop/interrupts.js";
import type { ModelRequestDebugStore } from "../domains/runtime/model-request-debug/index.js";
import {
  createInMemoryModelRequestDebugStore,
  createModelRequestDebugStore,
} from "../domains/runtime/model-request-debug/index.js";
import type { HandoffBriefStopper } from "../domains/runtime/ports/handoff-briefs.js";
import type { LocalObjectStoreAdapter, ObjectStorePort } from "../domains/storage/index.js";
import { createDrizzleEventJournalReader } from "../domains/threads/adapters/drizzle/event-reader.js";
import { createDrizzleEventJournalWriter } from "../domains/threads/adapters/drizzle/event-writer.js";
import { createDrizzleRepositories } from "../domains/threads/adapters/drizzle/index.js";
import { createInMemoryRepositories } from "../domains/threads/adapters/in-memory/index.js";
import { readThreadActivity } from "../domains/threads/domain/thread-activity.js";
import {
  type ActiveDocumentResolver,
  createActiveDocumentResolver,
  createInMemoryEventJournalWriter,
  requireThreadOwner,
} from "../domains/threads/index.js";
import type {
  EventJournalReader,
  EventJournalWriter,
  InternalThreadRepositories,
  ThreadRepositories,
  ThreadStatusReader,
} from "../domains/threads/ports/index.js";
import {
  createThreadRuntimeService,
  type ThreadRuntimeService,
} from "../domains/threads/runtime-service.js";
import { createThreadEventHub, type ThreadEventHub } from "../domains/threads/thread-event-hub.js";
import {
  createDrizzleWorkingSetRepository,
  createInMemoryWorkingSetRepository,
  type WorkingSetRepository,
} from "../domains/working-set/index.js";
import { runAfterDrizzleCommit, runInDrizzleSavepoint } from "../shared/drizzle-transaction.js";
import { InMemoryTransactionOwner } from "../shared/in-memory-transaction.js";
import { createDrizzleDocumentAccess, type DocumentAccessPort } from "./document-access.js";
import { resolveDebugPathsEnabled, resolveObsVerbose } from "./env.js";
import { createObjectStoreFromEnv } from "./object-store-factory.js";
import { readThreadContextDocument } from "./thread-context-route.js";
import {
  createAgentEditResponseWriteLifecycle,
  createReferenceReader,
  createWiredCoreToolRegistrations,
} from "./wired-core-tools.js";

export type AppServices = {
  gateway: Gateway;
  threadRepos: ThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  repos: ThreadRepositories;
  hub: ThreadEventHub;
  threadEventHub: ThreadEventHub;
  threadRuntime: ThreadRuntimeService;
  documentSync: CollabDomain;
  contextPorts: UnifiedContextPortFactory;
  contextCatalog: ContextCatalog;
  projectContextAvailability: ProjectContextAvailabilityPort;
  documentAddresses: DocumentAddressResolver;
  contextCatalogWakeHub: ContextCatalogWakeHub;
  documentLinks: DocumentLinkResolver;
  projects: ProjectBootstrapRepository;
  works: ProjectWorkRepository;
  projectRepo: ProjectRepository;
  users: UserRepository;
  accountSkillInstalls: AccountSkillInstallStore;
  workRepo: ProjectWorkRepository;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  workContext: WorkContextReader;
  workContextNotices: WorkContextNotices;
  billing: BillingService;
  agentRevisions: AgentRevisionStore;
  agentCatalog: BoundAgentCatalog;
  interruptRegistry: InterruptRegistry;
  eventSink: EventSink;
  eventQuery?: EventQuery;
  marsPackageFetcher: MarsPackageFetcher;
  preferences: ProjectPreferencesRepository;
  workingSet: WorkingSetRepository;
  recentDocuments: RecentDocumentsRepository;
  orchestrator: RunTurnPort;
  runner: TurnRunner;
  runStarter: RunStarter;
  delivery: DeliveryProducer & import("../domains/runtime/loop/runtime-delivery.js").ThreadControls;
  handoffBriefs: HandoffBriefs;
  /** Startup/interval recovery for threads with a pending message and no live run. */
  recovery: {
    scanWakes(): Promise<number>;
    repairOrphans(): Promise<number>;
    publishReports(): Promise<number>;
    handoffBriefs(): Promise<number>;
  };
  userTurnAdmission: UserTurnAdmission;
  runClaim: Pick<RunClaim, "withExclusiveThread">;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  modelRequestDebug: ModelRequestDebugStore;
  /** Dev-only scripted replies for the in-process mock model; null with real providers. */
  mockModelScript: MockScriptQueue | null;
  objectStore: ObjectStorePort;
  localObjectStore: LocalObjectStoreAdapter | null;
  uploadIntake: UploadIntake;
  uploadIdentity: UploadIdentityPort;
  figureAssets: FigureAssetService;
  results: ResultRepository;
  documentAccess: DocumentAccessPort;
  notices: NoticePort;
  changeTrails: ReturnType<typeof createDrizzleChangeTrailReader>;
  changeTrailDelivery: ReturnType<typeof createChangeTrailWorker>;
};

function stripeReady(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

export type ProductionAppPorts = {
  db: Database;
  gateway: Gateway;
  summarizerConfig: { model: string; maxOutputTokens: number };
  threadRepos: InternalThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  eventSink: EventSink;
  eventQuery?: EventQuery;
  documentSync: CollabDomain;
  contextPorts: UnifiedContextPortFactory;
  contextCatalog: ContextCatalog;
  projectContextAvailability: ProjectContextAvailabilityPort;
  documentAddresses: DocumentAddressResolver;
  contextCatalogWakeHub: ContextCatalogWakeHub;
  documentLinks: DocumentLinkResolver;
  projects: ProjectBootstrapRepository;
  works: ProjectWorkRepository;
  projectRepo: ProjectRepository;
  users: UserRepository;
  accountSkillInstalls: AccountSkillInstallStore;
  workRepo: ProjectWorkRepository;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  billing: BillingService;
  billingUsage: BillingUsagePolicy;
  billingSpendReader: BillingSpendReader;
  agentRevisions: AgentRevisionStore;
  marsPackageFetcher: MarsPackageFetcher;
  preferences: ProjectPreferencesRepository;
  workingSet: WorkingSetRepository;
  recentDocuments: RecentDocumentsRepository;
  modelRequestDebug: ModelRequestDebugStore;
  mockModelScript: MockScriptQueue | null;
  objectStore: ObjectStorePort;
  localObjectStore: LocalObjectStoreAdapter | null;
  uploadIntake: UploadIntake;
  uploadIdentity: UploadIdentityPort;
  figureAssets: FigureAssetService;
  results: ResultRepository;
  promotionService: PromotionService;
  documentAccess: DocumentAccessPort;
  notices: NoticePort;
  activeDocuments: ActiveDocumentResolver;
  runClaim: RunClaim;
  statusReader: ThreadStatusReader;
};

const CONCURRENT_RENDER_SAFETY_TOKENS = 16_000;

/** Max threads one wake sweep starts; the sweep repeats on its interval. */
const WAKE_SWEEP_LIMIT = 100;

function concurrentRenderBudgetBytes(request: {
  model?: string;
  messages: unknown;
  tools?: unknown;
}): number {
  const modelId = request.model ?? MODEL_REGISTRY.defaultModel;
  const model = MODEL_REGISTRY.providers
    .flatMap((provider) => provider.models)
    .find((candidate) => candidate.id === modelId);
  if (!model) return 0;
  const fixedRequestBytes = new TextEncoder().encode(
    JSON.stringify({ messages: request.messages, tools: request.tools }),
  ).byteLength;
  // Three UTF-8 bytes per remaining token deliberately underestimates capacity.
  const capacityBytes = Math.max(
    0,
    (model.contextWindow - model.maxOutputTokens - CONCURRENT_RENDER_SAFETY_TOKENS) * 3,
  );
  return Math.max(0, capacityBytes - fixedRequestBytes);
}

export async function createProductionAppPorts(input: {
  db: Database;
  eventSink: EventSink;
  eventQuery?: EventQuery;
  environment?: NodeJS.ProcessEnv;
}): Promise<ProductionAppPorts> {
  const environment = input.environment ?? process.env;
  const eventSink = input.eventSink;
  const debugPaths = resolveDebugPathsEnabled({
    rawNodeEnv: environment.NODE_ENV,
    rawAppEnv: environment.APP_ENV,
    debugFlag: environment.APP_DEBUG,
  });
  const {
    gateway: rawGateway,
    defaultModel,
    mockScript,
  } = await createGatewayFromEnv(environment, {
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
  const gateway = createInstrumentedGateway(rawGateway, {
    sink: eventSink,
    verbose: resolveObsVerbose({
      rawNodeEnv: environment.NODE_ENV,
      obsVerbose: environment.OBS_VERBOSE,
    }),
  });
  const db = input.db;
  const contextCatalogWakeHub = createContextCatalogWakeHub();
  const projectContextAvailability = createDrizzleProjectContextAvailability(db, eventSink);
  const contextCatalog = createDrizzleContextCatalog(db, contextCatalogWakeHub, {
    availabilityMutations: projectContextAvailability,
  });
  const workProjectionMutation = createWorkProjectionMutation({
    db,
    availability: projectContextAvailability,
    catalog: contextCatalog,
  });
  const runClaim = createDrizzleRunClaim(db, {
    holderId: `${process.pid}-${crypto.randomUUID()}`,
  });
  const statusReader = createDrizzleHandoffStatusReader(db, runClaim);
  const threadRepos = createDrizzleRepositories(db, workProjectionMutation, statusReader);
  const activeDocuments = createActiveDocumentResolver(threadRepos);
  const journalReader = createDrizzleEventJournalReader(db);
  const journalWriter = createDrizzleEventJournalWriter(db);
  const { objectStore, localObjectStore } = createObjectStoreFromEnv();
  const documentAccess = createDrizzleDocumentAccess(db);
  const notices = createDrizzleNoticePort(db);
  let workRepo: ProjectWorkRepository;
  const projectRepo = createDrizzleProjectRepository({
    db,
    catalogLifecycle: contextCatalog,
    ensureNoWork: (projectId) => workRepo.ensureNoWork(projectId),
  });
  const workAuthorityResolver = createDrizzleProjectWorkAuthorityResolver(db);
  let contextPorts: UnifiedContextPortFactory;
  const preferences = createDrizzleProjectPreferencesRepository({ db });
  const workingSet = createDrizzleWorkingSetRepository({ db });
  const recentDocuments = createDrizzleRecentDocumentsRepository({ db });
  const assetPathResolver = await createDrizzleAssetPathResolver(db);
  const documentSync = createCollabDomain({
    db,
    assetPathResolver,
    documentAccess,
    eventSink,
    notices,
    workAuthorityResolver,
    workProjectionMutation,
    threadContext: {
      async requireThreadOwner(input) {
        const thread = await requireThreadOwner(
          { threads: threadRepos.threads, projects: projectRepo },
          input.threadId,
          input.userId as never,
        );
        return { projectId: thread.projectId };
      },
      resolveContextDocument: (input) =>
        readThreadContextDocument(
          {
            contextPorts,
            threads: threadRepos.threads,
            threadWorks: threadRepos.threadWorks,
            works: workRepo,
            workAuthorityResolver,
          },
          input as never,
        ),
    },
  });
  const results = createDrizzleResultRepository(db);
  const promotionService = createPromotionService({
    objectStore,
    results,
    workAuthorityResolver,
    eventSink,
  });
  contextPorts = createProductionUnifiedContextPortFactory({
    db,
    documentSync,
    manifestMembership: documentSync,
    catalogMutations: contextCatalog,
    eventSink,
  });
  const uploadIntake = createUploadIntake({
    repository: createDrizzleUploadIntakeRepository(db, contextCatalog),
    content: createContextUploadContentPort(contextPorts),
    objectStore,
    eventSink,
  });
  const uploadIdentity = createDrizzleUploadIdentityPort(db);
  // Upload creates the asset as a context document, so the service needs the
  // context ports; it feeds each new path straight back into the resolver the
  // codec reads.
  const figureAssets = createFigureAssetService({
    objectStore,
    documents: createDrizzleFigureDocumentRepository({ db }),
    contextPorts,
    signedUrlExpiresAt: () => new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    eventSink,
    assetPaths: assetPathResolver,
  });
  const agentRevisions = createDrizzleAgentRevisionStore(db);
  await seedGeneralAgent(agentRevisions, defaultModel);
  const marsPackageFetcher = createGitHubMarsPackageFetcher({
    githubToken: environment.GITHUB_TOKEN,
  });
  await seedDefaultAgentPackages({
    store: agentRevisions,
    fetcher: marsPackageFetcher,
    config: defaultPackageSeedConfigFromEnv(environment),
  });
  const users = createDrizzleUserRepository({ db });
  const accountSkillInstalls = createDrizzleAccountSkillInstallStore(db);
  const projects = createDrizzleProjectBootstrapRepository({
    db,
    documents: documentSync,
    catalogLifecycle: contextCatalog,
  });
  workRepo = createDrizzleProjectWorkRepository({
    db,
    projectionMutation: workProjectionMutation,
    hasUnreviewedDraft: async (workId) =>
      ((await documentSync.countPendingByWorkIds([workId])).get(workId) ?? 0) > 0,
  });
  const creditLedger = createDrizzleCreditLedger(db);
  const stripeGateway = stripeReady(environment)
    ? createStripeBillingGateway({
        secretKey: environment.STRIPE_SECRET_KEY as string,
        webhookSecret: environment.STRIPE_WEBHOOK_SECRET as string,
      })
    : null;
  const summarizerModel = environment.COMPACTION_SUMMARIZER_MODEL ?? "deepseek-v4-flash";
  if (
    !MODEL_REGISTRY.providers.some((provider) =>
      provider.models.some((model) => model.id === summarizerModel),
    )
  ) {
    throw new Error(`Unknown compaction summarizer model: ${summarizerModel}`);
  }
  const getOrCreateStripeCustomer = createStripeCustomerProvisioner({ db, stripeGateway });
  const billingDomain = createBillingDomain({
    ledger: creditLedger,
    stripeGateway,
    getOrCreateStripeCustomer,
    env: environment,
  });

  return {
    db,
    runClaim,
    statusReader,
    gateway,
    summarizerConfig: {
      model: summarizerModel,
      maxOutputTokens: 4096,
    },
    threadRepos,
    journalReader,
    journalWriter,
    eventSink,
    eventQuery: input.eventQuery,
    documentSync,
    contextPorts,
    contextCatalog,
    projectContextAvailability,
    documentAddresses: createDocumentAddressResolver({
      locations: createDrizzleDocumentAddressStore(db),
      availability: projectContextAvailability,
    }),
    contextCatalogWakeHub,
    documentLinks: createDocumentLinkResolver({ catalog: contextCatalog, workAuthorityResolver }),
    projects,
    works: workRepo,
    projectRepo,
    users,
    accountSkillInstalls,
    workRepo,
    workAuthorityResolver,
    billing: billingDomain.service,
    billingUsage: billingDomain.usagePolicy,
    billingSpendReader: billingDomain.spendReader,
    agentRevisions,
    marsPackageFetcher,
    preferences,
    workingSet,
    recentDocuments,
    modelRequestDebug: createModelRequestDebugStore({ enabled: debugPaths, eventSink }),
    mockModelScript: debugPaths ? (mockScript ?? null) : null,
    objectStore,
    localObjectStore,
    uploadIntake,
    uploadIdentity,
    figureAssets,
    results,
    promotionService,
    documentAccess,
    notices,
    activeDocuments,
  };
}

/** Pure wiring — no env reads and no concrete adapter construction. */
export function composeAppServices(ports: ProductionAppPorts): AppServices {
  const threadEventHub = createThreadEventHub({
    journalReader: ports.journalReader,
    journalWriter: ports.journalWriter,
    eventSink: ports.eventSink,
    scheduleAfterCommit: runAfterDrizzleCommit,
  });
  const changeTrails = createDrizzleChangeTrailReader(ports.db, ports.documentAccess);
  const changeTrailDelivery = createChangeTrailWorker({
    db: ports.db,
    journalWriter: ports.journalWriter,
    eventHub: threadEventHub,
    retryBranch: (branchId) => ports.documentSync.pushToLive({ branchId }),
    recoverPendingLiveSettlements: () => ports.documentSync.recoverPendingLiveSettlements(),
  });
  const interruptRegistry = createInterruptRegistry();
  const workContext = createWorkContextReader({
    threads: ports.threadRepos.threads,
    works: ports.workRepo,
    threadWorks: ports.threadRepos.threadWorks,
  });
  const toolRegistry = createToolRegistry();
  let runner: TurnRunner;
  const runStarter = createRunStarter(
    { startDrain: (id) => runner.startDrain(id) },
    ports.eventSink,
  );
  let publishReport:
    | ((childThreadId: ThreadId, executionTurnId: TurnId) => Promise<unknown>)
    | undefined;
  const delivery = createDrizzleRuntimeDelivery(ports.db, {
    toolRegistry,
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    runClaim: ports.runClaim,
    notices: ports.notices,
    runStarter,
    workContext,
    async publishFinalizedReports(reports) {
      if (!publishReport) throw new Error("Report publisher is not initialized");
      for (const report of reports)
        await publishReport(report.childThreadId, report.executionTurnId);
    },
  });
  const workContextNotices = delivery;
  const responseWrites = createAgentEditResponseWriteLifecycle({
    documentSync: ports.documentSync,
    threadWorks: ports.threadRepos.threadWorks,
    works: ports.workRepo,
  });
  const coreToolDeps = {
    threads: ports.threadRepos.threads,
    contextPorts: ports.contextPorts,
    documentSync: ports.documentSync,
    responseWrites,
    threadWorks: ports.threadRepos.threadWorks,
    works: ports.workRepo,
    workAuthorityResolver: ports.workAuthorityResolver,
    drafts: ports.documentSync,
    workContextNotices,
    documentTouches: ports.threadRepos.documentTouches,
    eventSink: ports.eventSink,
    transaction: ports.threadRepos.transaction,
  };
  for (const registration of createWiredCoreToolRegistrations(coreToolDeps)) {
    toolRegistry.register(registration);
  }
  for (const registration of createInspectionToolRegistrations({
    repos: ports.threadRepos,
    statusReader: ports.statusReader,
    registry: toolRegistry,
    async tokenizer(caller) {
      const binding = await ports.agentRevisions.readThreadBinding(caller.id);
      const modelId = binding?.configuration.model ?? ports.gateway.getDefaultModel();
      const model = ports.gateway.listModels?.().find((model) => model.id === modelId);
      if (!model)
        return {
          ok: false,
          error: meridianErrorFromSystem("model_unavailable", `Model not found: ${modelId}`),
        };
      return model.tokenizer;
    },
  }))
    toolRegistry.register(registration);
  for (const registration of createSpawnToolRegistrations()) {
    toolRegistry.register(registration);
  }
  for (const registration of createSkillToolRegistrations({
    async loadBody(threadId, slug) {
      const thread = await ports.threadRepos.threads.findById(threadId as never);
      if (!thread) throw new SkillUnavailableError(slug);
      return loadModelSkillBody({
        thread,
        slug,
        agentRevisions: ports.agentRevisions,
      });
    },
  })) {
    toolRegistry.register(registration);
  }
  const toolExecutor = createToolExecutor(toolRegistry);
  const readActivity = (threadId: ThreadId) =>
    readThreadActivity(
      {
        threads: ports.threadRepos.threads,
        statusReader: ports.statusReader,
        executionReports: ports.threadRepos.executionReports,
      },
      threadId,
    );
  // A drain-woken subagent run (a child report or thread_message) has no driver
  // to emit its activity frames; refresh its parent's activity when its lease goes
  // live and after it releases, so the strip never reads `asleep` during the run
  // nor stays `awake` after it.
  const refreshSubagentActivity = createSubagentActivityRefresher({
    findThread: (id) => ports.threadRepos.threads.findById(id),
    eventWriter: threadEventHub,
    readActivity,
    eventSink: ports.eventSink,
  });
  const threadLock = createDrizzleThreadLock(ports.db);
  const inbox = delivery;
  const readPending = (threadId: ThreadId) => readPendingInbox(delivery, threadId);
  const reportPublisher = createReportPublisher({
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    delivery,
    eventSink: ports.eventSink,
  });
  publishReport = reportPublisher.publish;
  const orphanRepair = createOrphanReportRepair({
    toolRegistry,
    inbox: delivery,
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    authority: ports.runClaim,
    threadLock,
    publisher: reportPublisher,
    eventSink: ports.eventSink,
  });
  let wakeCursor: ThreadId | undefined;
  const recovery = {
    async scanWakes() {
      const page = await sweepWakes({
        delivery,
        authority: ports.runClaim,
        runStarter,
        limit: WAKE_SWEEP_LIMIT,
        afterThreadId: wakeCursor,
        eventSink: ports.eventSink,
      });
      wakeCursor = page.cursor;
      return page.count;
    },
    repairOrphans: () => orphanRepair.sweep(WAKE_SWEEP_LIMIT),
    publishReports: () => reportPublisher.sweep(WAKE_SWEEP_LIMIT),
    handoffBriefs: () => handoffBriefs.sweep(WAKE_SWEEP_LIMIT),
  };
  const admissionRecords = createDrizzleAdmissionRecords(ports.db);
  const imageAssets = createContextImageAssetPort({
    identities: ports.uploadIdentity,
    availability: ports.projectContextAvailability,
    objects: ports.objectStore,
    eventSink: ports.eventSink,
  });
  const admissionProducer = createWriterTurnProducer({
    inbox,
    persistence: {
      repos: ports.threadRepos,
      eventWriter: threadEventHub,
      savepoint: (operation) => runInDrizzleSavepoint(ports.db, operation),
    },
    hub: threadEventHub,
    runner: { getRunningTurn: (id) => runner.getRunningTurn(id) },
    turns: ports.threadRepos.turns,
    delivery,
    records: admissionRecords,
    consumeUploads: (documentIds) => ports.uploadIntake.consume(documentIds),
    attachDocument: (threadId, documentId, relationship) =>
      ports.threadRepos.threadDocuments.attach(threadId as never, documentId, relationship),
  });
  const userTurnAdmission = createUserTurnAdmission({
    runClaim: ports.runClaim,
    records: admissionRecords,
    availability: ports.projectContextAvailability,
    async threadProject(threadId) {
      return (await ports.threadRepos.threads.findById(threadId as never))?.projectId ?? null;
    },
    async verifyDraftUpload(reference) {
      const identity = await ports.uploadIdentity.lookupUpload(reference.documentId);
      return identity?.intakeId === reference.intakeId && identity.uri === reference.uri;
    },
    async authorizeActivatedSkills({ threadId, slugs }) {
      const thread = await ports.threadRepos.threads.findById(threadId as never);
      if (!thread) throw new InvalidAdmissionError("thread is unavailable");
      const available = await resolveThreadUserInvocableSkills({
        thread,
        agentRevisions: ports.agentRevisions,
        accountSkillInstalls: ports.accountSkillInstalls,
      });
      const missing = unavailableActivatedSkillSlugs(available, slugs);
      if (missing[0]) throw new InvalidAdmissionError(`Skill "${missing[0]}" is not available`);
    },
    producer: admissionProducer,
  });
  const childRunDriver = createChildRunDriver({
    orchestrator: { prepare: (input) => runner.prepare(input) },
    repos: { executionReports: ports.threadRepos.executionReports },
    // The live hub, not the bare journal writer: background lifecycle must reach
    // subscribers at append time, in append order. A notifier-relayed write lands
    // after later in-process appends and is dropped as stale by the WS cursor.
    eventWriter: threadEventHub,
    readActivity,
    publisher: reportPublisher,
    eventSink: ports.eventSink,
  });
  const childRunCoordinator = createChildRunCoordinator({
    driver: childRunDriver,
    delivery,
    unavailableReasons: (definition, model) =>
      agentExecutionUnavailableReasons(definition, ports.gateway, model),
    modelUnavailable: (model) => agentModelUnavailableReasons(ports.gateway, model),
    defaultModel: () => ports.gateway.getDefaultModel(),
    repos: {
      threads: ports.threadRepos.threads,
      subagentThreads: ports.threadRepos.threads,
      transaction: ports.threadRepos.transaction,
    },
    resolveWorkMembership: async (input) => {
      const { resolveWorkMembership } = await import("./work-attachment.js");
      return resolveWorkMembership(
        {
          workRepo: ports.workRepo,
          threadWorks: ports.threadRepos.threadWorks,
        },
        input,
      );
    },
    eventWriter: threadEventHub,
    readActivity,
    agentRevisions: ports.agentRevisions,
    eventSink: ports.eventSink,
  });
  let handoffBriefs!: HandoffBriefs;
  const handoffBriefStopper: HandoffBriefStopper = {
    stop: (threadId, seedTurnId) => handoffBriefs.stop(threadId, seedTurnId),
  };
  const orchestratorDeps = {
    summarizer: createConversationSummarizer({
      gateway: ports.gateway,
      agentRevisions: ports.agentRevisions,
      prefixCacheStateFor: createPrefixCacheStateService({ repos: ports.threadRepos })
        .prefixCacheStateFor,
      config: ports.summarizerConfig,
    }),
    headSeq: (id: ThreadId) => threadEventHub.headSeq(id),
    onRunStarted: refreshSubagentActivity,
    onRunSettled(threadId: ThreadId) {
      refreshSubagentActivity(threadId);
    },
    gateway: ports.gateway,
    referenceReader: createReferenceReader(coreToolDeps),
    documentRevisions: createDocumentRevisions({
      threads: ports.threadRepos.threads,
      availability: ports.projectContextAvailability,
      documents: ports.documentSync,
      threadWorks: coreToolDeps.threadWorks,
      works: coreToolDeps.works,
    }),
    toolExecutor,
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    agentRevisions: ports.agentRevisions,
    accountSkillInstalls: ports.accountSkillInstalls,
    toolRegistry,
    projectPreferences: ports.preferences,
    workWriteMode: {
      async read(workId: string) {
        const work = await ports.workRepo.findById(workId as import("@meridian/contracts").WorkId);
        if (!work) throw new Error(`Work not found: ${workId}`);
        return work.aiWriteMode;
      },
    },
    workContext,
    childRunCoordinator,
    interruptRegistry,
    billingUsage: ports.billingUsage,
    interruptArtifacts: createInterruptArtifactFlush({
      promotion: ports.promotionService,
      objectStore: ports.objectStore,
    }),
    eventSink: ports.eventSink,
    modelRequestDebug: ports.modelRequestDebug,
    responseWrites,
    delivery,
    runClaim: ports.runClaim,
    handoffBriefs: handoffBriefStopper,
    activeDocuments: ports.activeDocuments,
    imageAssets,
    concurrentRenderBudgetBytes,
  };
  const orchestrator = createOrchestrator(orchestratorDeps);
  runner = orchestrator;
  handoffBriefs = createHandoffBriefs({
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    eventSink: ports.eventSink,
    threadLock,
    claim: createDrizzleHandoffBriefClaim(ports.db),
    runClaim: ports.runClaim,
    runStarter,
    billingUsage: ports.billingUsage,
    toolRegistry,
    generate: ({ destination, seed, signal }) =>
      generateHandoffBrief(orchestratorDeps, destination, seed, signal),
    async publishStatus(threadId) {
      const status = await ports.statusReader.read(threadId);
      const runningTurnId = await ports.statusReader.readRunningTurnId(threadId);
      await threadEventHub.appendEvent(threadId, {
        type: "thread.status",
        threadId,
        status,
        runningTurnId,
      });
    },
    schedulePostCommit: runAfterDrizzleCommit,
  });

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
      statusReader: ports.statusReader,
      threads: ports.threadRepos.threads,
      executionReports: ports.threadRepos.executionReports,
      readPending,
      readCompactionUndo: createCompactionUndoReader({
        agentRevisions: ports.agentRevisions,
        toolRegistry,
        gateway: ports.gateway,
      }),
    }),
    documentSync: ports.documentSync,
    contextPorts: ports.contextPorts,
    contextCatalog: ports.contextCatalog,
    projectContextAvailability: ports.projectContextAvailability,
    documentAddresses: ports.documentAddresses,
    contextCatalogWakeHub: ports.contextCatalogWakeHub,
    documentLinks: ports.documentLinks,
    projects: ports.projects,
    works: ports.works,
    projectRepo: ports.projectRepo,
    users: ports.users,
    accountSkillInstalls: ports.accountSkillInstalls,
    workRepo: ports.workRepo,
    workAuthorityResolver: ports.workAuthorityResolver,
    workContext,
    workContextNotices,
    billing: ports.billing,
    agentRevisions: ports.agentRevisions,
    agentCatalog: createBoundAgentCatalog({
      store: ports.agentRevisions,
      defaultModel: () => ports.gateway.getDefaultModel(),
      unavailableReasons: (definition, model) =>
        agentExecutionUnavailableReasons(definition, ports.gateway, model),
    }),
    interruptRegistry,
    eventSink: ports.eventSink,
    eventQuery: ports.eventQuery,
    marsPackageFetcher: ports.marsPackageFetcher,
    preferences: ports.preferences,
    workingSet: ports.workingSet,
    recentDocuments: ports.recentDocuments,
    orchestrator,
    runner,
    runStarter,
    delivery,
    recovery,
    handoffBriefs,
    userTurnAdmission,
    runClaim: ports.runClaim,
    toolRegistry,
    toolExecutor,
    modelRequestDebug: ports.modelRequestDebug,
    mockModelScript: ports.mockModelScript,
    objectStore: ports.objectStore,
    localObjectStore: ports.localObjectStore,
    uploadIntake: ports.uploadIntake,
    uploadIdentity: ports.uploadIdentity,
    figureAssets: ports.figureAssets,
    results: ports.results,
    documentAccess: ports.documentAccess,
    notices: ports.notices,
    changeTrails,
    changeTrailDelivery,
  };
}

export function createInMemoryAppServices(): AppServices {
  const transactionOwner = new InMemoryTransactionOwner();
  const threadRepos = createInMemoryRepositories({
    transactionOwner,
    boundAgent: (id) => agentRevisions.boundAgent(id),
  });
  const agentRevisions = createInMemoryAgentRevisionStore({
    transactionOwner,
    threadExists: async (id) =>
      Boolean(await threadRepos.threads.findProjectIdByIdIncludingDeleted(id)),
  });
  const preferences = createInMemoryProjectPreferencesRepository();
  const workingSet = createInMemoryWorkingSetRepository();
  const recentDocuments = createInMemoryRecentDocumentsRepository();
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
  const inbox = createInMemoryInbox();
  const runClaim = createInMemoryRunClaim({
    prioritizePendingControls: inbox.prioritizePendingControls,
  });
  const runStarter = createInMemoryRunStarter();
  const delivery = createInMemoryRuntimeDelivery({
    workContext: {
      async renderForThread() {
        throw new Error("No Work context configured");
      },
    },
    repos: threadRepos,
    eventWriter: createInMemoryEventJournalWriter(),
    notices,
    runClaim,
    inbox,
    threadLock: createInMemoryThreadLock(),
    runStarter,
    async publishFinalizedReports() {},
    schedulePostCommit: (task) => {
      void task();
    },
  });
  const handoffBriefs: HandoffBriefs = {
    async launch() {},
    launchAfterCommit() {},
    async stop() {
      return false;
    },
    async retry() {
      throw new Error("in-memory handoff retry is not implemented");
    },
    async sweep() {
      return 0;
    },
  };
  const recovery = {
    async scanWakes() {
      return 0;
    },
    async repairOrphans() {
      return 0;
    },
    async publishReports() {
      return 0;
    },
    async handoffBriefs() {
      return 0;
    },
  };

  const documentSync: CollabDomain = createInMemoryCollabDomain();
  const unavailableWorkContext: WorkContextReader = {
    async renderForThread() {
      throw new Error("in-memory Work context is not configured");
    },
  };
  const inMemoryThreadEventHub: ThreadEventHub = {
    invalidateCommittedJournal() {},
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
      return { catchup: [], unsubscribe: () => undefined };
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

  const contextCatalog = new InMemoryContextCatalog();
  const workAuthorityResolver: ProjectWorkAuthorityResolver = {
    async byId() {
      return null;
    },
    async bySlug() {
      return null;
    },
    async noWork() {
      return null;
    },
    async lockById() {
      return null;
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
      readCompactionUndo: undefined,
      async requireOwnedThread() {
        throw new Error("in-memory thread runtime is not implemented");
      },
      async liveState() {
        throw new Error("in-memory thread runtime is not implemented");
      },
      async read() {
        return { kind: "asleep" as const };
      },
      async readMany() {
        return new Map();
      },
      async readRunningTurnId() {
        return null;
      },
      async readPending() {
        return { items: [] };
      },
      async journalEvents() {
        return [];
      },
    },
    documentSync,
    contextPorts: createInMemoryUnifiedContextPortFactory({ documentSync }),
    contextCatalog,
    documentAddresses: {
      async resolve() {
        return { kind: "unavailable" };
      },
    },
    projectContextAvailability: {
      async lookup(input) {
        return {
          projectId: input.projectId,
          resolutionId: crypto.randomUUID(),
          resolutions: [...new Set(input.documentIds)].map((documentId) => ({
            kind: "not-visible" as const,
            documentId,
            checkedGeneration: "0",
          })),
        };
      },
    },
    contextCatalogWakeHub: createContextCatalogWakeHub(),
    documentLinks: createDocumentLinkResolver({ catalog: contextCatalog, workAuthorityResolver }),
    projects: {
      async ensureDefaultBootstrapReady() {
        return false;
      },
      async ensureDefaultBootstrap() {
        throw new Error("in-memory projects are not implemented");
      },
    },
    works: {
      async transaction(operation) {
        return operation();
      },
      async readSnapshot(operation) {
        return operation();
      },
      async snapshotIdentity() {
        return { catalogGeneration: crypto.randomUUID(), authorityRevision: "0" };
      },
      async create() {
        throw new Error("in-memory work repository is not implemented");
      },
      async findById() {
        throw new Error("in-memory work repository is not implemented");
      },
      async findNoWork() {
        return null;
      },
      async ensureNoWork() {
        throw new Error("in-memory work repository is not implemented");
      },
      async lockById() {
        throw new Error("in-memory work repository is not implemented");
      },
      async listByProject() {
        return [];
      },
      async update() {
        throw new Error("in-memory work repository is not implemented");
      },
      async archive() {
        throw new Error("in-memory work repository is not implemented");
      },
      async unarchive() {
        throw new Error("in-memory work repository is not implemented");
      },
      async hasUnreviewedDraft() {
        return false;
      },
      async softDelete() {
        throw new Error("in-memory work repository is not implemented");
      },
      async restore() {
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
      async findLiveByOwnerSlug() {
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
      async getWorkingSetSyncEnabled() {
        return true;
      },
      async updateWorkingSetSyncEnabled(_userId, enabled) {
        return enabled;
      },
    },
    accountSkillInstalls: createInMemoryAccountSkillInstallStore(),
    workRepo: {
      async transaction(operation) {
        return operation();
      },
      async readSnapshot(operation) {
        return operation();
      },
      async snapshotIdentity() {
        return { catalogGeneration: crypto.randomUUID(), authorityRevision: "0" };
      },
      async create() {
        throw new Error("in-memory work repository is not implemented");
      },
      async findById() {
        throw new Error("in-memory work repository is not implemented");
      },
      async findNoWork() {
        return null;
      },
      async ensureNoWork() {
        throw new Error("in-memory work repository is not implemented");
      },
      async lockById() {
        throw new Error("in-memory work repository is not implemented");
      },
      async listByProject() {
        throw new Error("in-memory work repository is not implemented");
      },
      async update() {
        throw new Error("in-memory work repository is not implemented");
      },
      async archive() {
        throw new Error("in-memory work repository is not implemented");
      },
      async unarchive() {
        throw new Error("in-memory work repository is not implemented");
      },
      async hasUnreviewedDraft() {
        return false;
      },
      async softDelete() {
        throw new Error("in-memory work repository is not implemented");
      },
      async restore() {
        throw new Error("in-memory work repository is not implemented");
      },
      async touch() {},
    },
    workAuthorityResolver,
    workContext: unavailableWorkContext,
    workContextNotices: delivery,
    billing: billingDomain.service,
    agentRevisions,
    agentCatalog: createBoundAgentCatalog({
      store: agentRevisions,
      defaultModel: () => "mock-model",
      unavailableReasons: (definition, model) =>
        agentExecutionUnavailableReasons(definition, {}, model),
    }),
    interruptRegistry: createInterruptRegistry(),
    eventSink: createNoopEventSink(),
    marsPackageFetcher: {
      async fetch() {
        throw new Error("in-memory Mars package fetcher is not implemented");
      },
    },
    preferences,
    workingSet,
    recentDocuments,
    orchestrator: {
      async prepare() {
        throw new Error("in-memory orchestrator is not implemented");
      },
    },
    runner: {
      async prepare() {
        throw new Error("in-memory run preparation is not implemented");
      },
      getRunningTurn() {
        return null;
      },
      getRunningTurnId() {
        return null;
      },
      isThreadRunning() {
        return false;
      },
      async startDrain() {
        throw new Error("in-memory turn runner is not implemented");
      },
      async cancel() {
        return "not_found" as const;
      },
    },
    runStarter,
    delivery,
    recovery,
    handoffBriefs,
    userTurnAdmission: {
      async admit(input) {
        return { kind: "rejected", submissionId: input.submissionId, code: "invalid_message" };
      },
      async lookup(input) {
        return { kind: "not-seen", submissionId: input.submissionId };
      },
      async retire(input) {
        return { kind: "retired", submissionId: input.submissionId, code: "retired" };
      },
    },
    runClaim,
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
    uploadIntake: {
      async intake() {
        throw new Error("in-memory upload intake is not implemented");
      },
      async deleteDraft() {
        return { kind: "identity_mismatch" };
      },
      async consume() {},
    },
    uploadIdentity: {
      async lookupUpload() {
        return null;
      },
      async lookupDocument() {
        return null;
      },
      async lookupDocuments() {
        return [];
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
      async createOrConverge() {
        throw new Error("in-memory results are not implemented");
      },
      async listByProject() {
        return [];
      },
    },
    documentAccess: {
      async documentAccessState() {
        return "available";
      },
      async lockDocumentAccessState() {
        return "available";
      },
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
    mockModelScript: null,
    changeTrails: {
      async listShells() {
        return [];
      },
      async readDetails() {
        return [];
      },
    },
    changeTrailDelivery: {
      async drain() {
        return 0;
      },
    },
  };
}

function createInMemoryNoticePort(): NoticePort {
  const rows: Notice[] = [];
  let nextId = 1;
  return {
    async record(input) {
      const notice: Notice = { ...input, id: nextId++, createdAt: new Date() };
      rows.push(notice);
    },
    async peek(threadId) {
      return rows.filter((notice) => notice.scope.threadId === threadId);
    },
    async consume(ids) {
      const consumed = new Set(ids);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (consumed.has(rows[index]?.id ?? -1)) rows.splice(index, 1);
      }
    },
  };
}

export type { ThreadRepositories } from "../domains/threads/ports/index.js";
