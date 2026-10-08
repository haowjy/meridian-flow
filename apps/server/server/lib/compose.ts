/**
 * Composition root: wires production adapters into AppServices and owns the pure
 * runtime service graph. App startup supplies process-level resources; this file
 * chooses concrete server adapters and assembles domain services behind ports.
 */

import type { AgentPermission } from "@meridian/contracts/agents";
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
  type ContextCatalogMutationPort,
  type ContextCatalogWakeHub,
  createContextCatalogWakeHub,
  createContextUploadContentPort,
  createDocumentAddressResolver,
  createDocumentLinkResolver,
  createDocumentRevisions,
  createDrizzleContextCatalog,
  createDrizzleDocumentAddressStore,
  createDrizzleDocumentAssetPaths,
  createDrizzleDocumentLinkHistory,
  createDrizzleFigureDocumentRepository,
  createDrizzleLineageScratchLifecycle,
  createDrizzleProjectContextAvailability,
  createDrizzleResultRepository,
  createDrizzleScratchLineages,
  createDrizzleUploadIdentityPort,
  createDrizzleUploadIntakeRepository,
  createFigureAssetService,
  createInMemoryUnifiedContextPortFactory,
  createInterruptArtifactFlush,
  createLinkUpdateWorker,
  createProductionUnifiedContextPortFactory,
  createPromotionService,
  createUploadIntake,
  type DocumentAddressResolver,
  type DocumentLinkResolver,
  type FigureAssetService,
  InMemoryContextCatalog,
  type LinkUpdateWorker,
  type ProjectCatalogLifecyclePort,
  type ProjectContextAvailabilityPort,
  type ProjectDocumentCatalogRefreshPort,
  type PromotionService,
  type ResultRepository,
  type UnifiedContextPortFactory,
  type UploadIdentityPort,
  type UploadIntake,
} from "../domains/context/index.js";
import {
  type AgentChain,
  createAllowAllFileAccess,
  createDrizzleFileFacts,
  createFileAccess,
  createLocalFileAccessChanges,
  createOwnerFileGrants,
  createPgFileAccessChanges,
  type FileAccess,
  type FileAccessChanges,
  type PgFileAccessChanges,
} from "../domains/file-policy/index.js";
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
  createDrizzleWorkPurger,
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
import {
  createDetachedWorkTracker,
  type DetachedWorkTracker,
} from "../domains/runtime/detached-work.js";
import { MODEL_REGISTRY, type MockScriptQueue } from "../domains/runtime/gateway/index.js";
import { generateHandoffBrief } from "../domains/runtime/handoff/brief-request.js";
import {
  createHandoffBriefs,
  type HandoffBriefs,
} from "../domains/runtime/handoff/brief-service.js";
import {
  createChildRunCoordinator,
  createChildRunDriver,
  createContextImageAssetPort,
  createConversationSummarizer,
  createDrizzleAdmissionRecords,
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
  readAgentChain,
  readChainPermission,
  readPendingInbox,
  requireWritableThread,
  sweepWakes,
  type ToolExecutor,
  type ToolRegistry,
  type TurnRunner,
  type UserTurnAdmission,
  type WorkContextNotices,
  type WorkContextReader,
} from "../domains/runtime/index.js";
import {
  resolveThreadUserInvocableSkills,
  unavailableActivatedSkillSlugs,
} from "../domains/runtime/loop/available-skills.js";
import {
  createInterruptRegistry,
  type InterruptRegistry,
} from "../domains/runtime/loop/interrupts.js";
import { createWakeIfRunnable } from "../domains/runtime/loop/wake-if-runnable.js";
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
import { lockThreadAndWorks } from "../shared/thread-work-lock.js";
import { resolveDebugPathsEnabled, resolveObsVerbose } from "./env.js";
import {
  createAgentEditResponseWriteLifecycle,
  createModelToolRegistrations,
  createReferenceReader,
} from "./model-tools/index.js";
import { createObjectStoreFromEnv } from "./object-store-factory.js";
import { APP_DRAIN_DEADLINE_MS } from "./shutdown-deadlines.js";
import { readThreadContextDocument } from "./thread-context-route.js";

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
  contextCatalogRefresh: ProjectDocumentCatalogRefreshPort;
  projectContextAvailability: ProjectContextAvailabilityPort;
  documentAddresses: DocumentAddressResolver;
  contextCatalogWakeHub: ContextCatalogWakeHub;
  documentLinks: DocumentLinkResolver;
  linkUpdates: LinkUpdateWorker;
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
  stopThreadRun(threadId: ThreadId): Promise<void>;
  runStarter: RunStarter;
  delivery: DeliveryProducer & import("../domains/runtime/loop/runtime-delivery.js").ThreadControls;
  handoffBriefs: HandoffBriefs;
  shutdown(): Promise<void>;
  /** Startup/interval recovery for threads with a pending message and no live run. */
  recovery: {
    scanWakes(): Promise<number>;
    repairOrphans(): Promise<number>;
    publishReports(): Promise<number>;
    purgeWorks(): Promise<number>;
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
  /** The file policy every route and model call asks (file-access §1). */
  fileAccess: FileAccess;
  /** Work lifecycle changes that re-decide live rooms' access, on every instance (§7). */
  fileAccessChanges: FileAccessChanges;
  notices: NoticePort;
  changeTrails: ReturnType<typeof createDrizzleChangeTrailReader>;
  changeTrailDelivery: ReturnType<typeof createChangeTrailWorker>;
};

function stripeReady(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

export type ProductionAppPorts = {
  db: Database;
  /** Detached work any port started; the composed app drains it at shutdown. */
  backgroundTasks: DetachedWorkTracker;
  /** A thread's delegation chain, read fresh (file-access §8). */
  readAgentChain(threadId: ThreadId): Promise<AgentChain>;
  /** The chain's effective permission, from the lighter lineage walk. */
  readChainPermission(threadId: ThreadId): Promise<AgentPermission>;
  /** The file policy every model read and write asks (file-access §1). */
  fileAccess: FileAccess;
  fileAccessChanges: PgFileAccessChanges;
  gateway: Gateway;
  summarizerConfig: { model: string };
  threadRepos: InternalThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  eventSink: EventSink;
  eventQuery?: EventQuery;
  documentSync: CollabDomain;
  contextPorts: UnifiedContextPortFactory;
  contextCatalog: ContextCatalog &
    ContextCatalogMutationPort &
    ProjectCatalogLifecyclePort &
    ProjectDocumentCatalogRefreshPort;
  projectContextAvailability: ProjectContextAvailabilityPort;
  documentAddresses: DocumentAddressResolver;
  contextCatalogWakeHub: ContextCatalogWakeHub;
  documentLinks: DocumentLinkResolver;
  linkUpdates: LinkUpdateWorker;
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
  const backgroundTasks = createDetachedWorkTracker();
  const contextCatalogWakeHub = createContextCatalogWakeHub();
  const projectContextAvailability = createDrizzleProjectContextAvailability(db, eventSink);
  let boundManifestMembership: CollabDomain | null = null;
  const contextCatalog = createDrizzleContextCatalog(db, contextCatalogWakeHub, {
    availabilityMutations: projectContextAvailability,
    eventSink,
    backgroundTasks,
    manifestMembership: {
      resolveManifestMembership: (input) => {
        if (!boundManifestMembership) {
          throw new Error("Manifest membership resolver used before the collab domain was bound");
        }
        return boundManifestMembership.resolveManifestMembership(input);
      },
    },
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
  const lineageScratch = createDrizzleLineageScratchLifecycle(db, contextCatalog);
  const threadRepos = createDrizzleRepositories(
    db,
    workProjectionMutation,
    lineageScratch,
    statusReader,
  );
  const activeDocuments = createActiveDocumentResolver(threadRepos);
  const journalReader = createDrizzleEventJournalReader(db);
  const journalWriter = createDrizzleEventJournalWriter(db);
  const { objectStore, localObjectStore } = createObjectStoreFromEnv();
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
  const assetPaths = createDrizzleDocumentAssetPaths(db, eventSink);
  const agentRevisions = createDrizzleAgentRevisionStore(db);
  const chainDeps = {
    threads: threadRepos.threads,
    threadWorks: threadRepos.threadWorks,
    agentRevisions,
    works: { findById: (id: string) => workRepo.findById(id) },
  };
  const readChain = (threadId: ThreadId) => readAgentChain(chainDeps, threadId);
  const fileAccess = createFileAccess({
    facts: createDrizzleFileFacts(db),
    grants: createOwnerFileGrants(),
    readAgentChain: readChain,
  });
  const documentSync = createCollabDomain({
    db,
    fileAccess,
    assetPaths,
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
            fileAccess,
            threads: threadRepos.threads,
            threadWorks: threadRepos.threadWorks,
            works: workRepo,
            workAuthorityResolver,
          },
          input as never,
        ),
    },
  });
  boundManifestMembership = documentSync;
  const results = createDrizzleResultRepository(db);
  const promotionService = createPromotionService({
    lineages: createDrizzleScratchLineages(db),
    objectStore,
    results,
    workAuthorityResolver,
    eventSink,
  });
  const linkUpdates = createLinkUpdateWorker({
    db,
    rewriteDocumentLinks: documentSync.rewriteDocumentLinks,
    eventSink,
  });
  contextPorts = createProductionUnifiedContextPortFactory({
    assetPaths,
    db,
    documentSync,
    manifestMembership: documentSync,
    documentDerivations: documentSync.documentDerivations,
    kickLinkUpdates: linkUpdates.kick,
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
  // context ports.
  const figureAssets = createFigureAssetService({
    objectStore,
    documents: createDrizzleFigureDocumentRepository({ db }),
    contextPorts,
    signedUrlExpiresAt: () => new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    eventSink,
  });
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
  const fileAccessChanges = createPgFileAccessChanges({ db, eventSink });
  workRepo = createDrizzleProjectWorkRepository({
    db,
    projectionMutation: workProjectionMutation,
    fileAccessChanges,
    lineageScratch,
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
    backgroundTasks,
    runClaim,
    statusReader,
    gateway,
    summarizerConfig: { model: summarizerModel },
    fileAccess,
    fileAccessChanges,
    threadRepos,
    journalReader,
    journalWriter,
    eventSink,
    eventQuery: input.eventQuery,
    documentSync,
    linkUpdates,
    contextPorts,
    contextCatalog,
    projectContextAvailability,
    documentAddresses: createDocumentAddressResolver({
      locations: createDrizzleDocumentAddressStore(db),
      availability: projectContextAvailability,
    }),
    contextCatalogWakeHub,
    documentLinks: createDocumentLinkResolver({
      catalog: contextCatalog,
      workAuthorityResolver,
      history: createDrizzleDocumentLinkHistory(db),
      lineages: createDrizzleScratchLineages(db),
    }),
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
    notices,
    activeDocuments,
    readAgentChain: readChain,
    readChainPermission: (threadId: ThreadId) => readChainPermission(chainDeps, threadId),
  };
}

/** Pure wiring — no env reads and no concrete adapter construction. */
export function composeAppServices(ports: ProductionAppPorts): AppServices {
  const { backgroundTasks } = ports;
  const shutdown = { started: false };
  const threadEventHub = createThreadEventHub({
    journalReader: ports.journalReader,
    journalWriter: ports.journalWriter,
    eventSink: ports.eventSink,
    scheduleAfterCommit: runAfterDrizzleCommit,
  });
  const changeTrails = createDrizzleChangeTrailReader(ports.db, ports.fileAccess);
  const changeTrailDelivery = createChangeTrailWorker({
    db: ports.db,
    journalWriter: ports.journalWriter,
    eventHub: threadEventHub,
    recoverPendingLiveSettlements: () => ports.documentSync.recoverPendingLiveSettlements(),
  });
  const interruptRegistry = createInterruptRegistry();
  const workContext = createWorkContextReader({
    threads: ports.threadRepos.threads,
    works: ports.workRepo,
    threadWorks: ports.threadRepos.threadWorks,
    readChainPermission: ports.readChainPermission,
  });
  const toolRegistry = createToolRegistry();
  let runner: TurnRunner;
  const runStarter = createRunStarter(
    { startDrain: (id) => runner.startDrain(id) },
    ports.eventSink,
  );
  const publishThreadStatus = async (threadId: ThreadId) => {
    const status = await ports.statusReader.read(threadId);
    const runningTurnId = await ports.statusReader.readRunningTurnId(threadId);
    await threadEventHub.appendEvent(threadId, {
      type: "thread.status",
      threadId,
      status,
      runningTurnId,
    });
  };
  let publishReport:
    | ((childThreadId: ThreadId, executionTurnId: TurnId) => Promise<unknown>)
    | undefined;
  const stopThreadRun = async (threadId: ThreadId) => {
    const turnId = await ports.runClaim.readRunningTurnId(threadId);
    if (turnId) await runner.cancel(threadId, turnId);
  };
  const delivery = createDrizzleRuntimeDelivery(ports.db, {
    backgroundTasks,
    toolRegistry,
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    runClaim: ports.runClaim,
    notices: ports.notices,
    runStarter,
    workContext,
    publishStatus: publishThreadStatus,
    async publishFinalizedReports(reports) {
      if (!publishReport) throw new Error("Report publisher is not initialized");
      for (const report of reports)
        await publishReport(report.childThreadId, report.executionTurnId);
    },
  });
  const wakeIfRunnable = createWakeIfRunnable({ delivery, runStarter, shutdown });
  const workContextNotices = delivery;
  const responseWrites = createAgentEditResponseWriteLifecycle({
    documentSync: ports.documentSync,
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
    stopThreadRun,
    documentTouches: ports.threadRepos.documentTouches,
    eventSink: ports.eventSink,
    objectStore: ports.objectStore,
    fileAccess: ports.fileAccess,
    agentRevisions: ports.agentRevisions,
    readAgentChain: ports.readAgentChain,
    readChainPermission: ports.readChainPermission,
  };
  for (const registration of createModelToolRegistrations(coreToolDeps)) {
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
  const workPurger = createDrizzleWorkPurger({
    db: ports.db,
    objectStore: ports.objectStore,
    eventSink: ports.eventSink,
  });
  const orphanRepair = createOrphanReportRepair({
    toolRegistry,
    inbox: delivery,
    retireOrphanedReply: delivery.retireOrphanedReply,
    clearOrphanedTurn: delivery.clearOrphanedTurn,
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    authority: ports.runClaim,
    threadLock,
    publisher: reportPublisher,
    eventSink: ports.eventSink,
    publishStatus: publishThreadStatus,
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
    purgeWorks: () => workPurger.sweep(),
  };
  const admissionRecords = createDrizzleAdmissionRecords(ports.db);
  const imageAssets = createContextImageAssetPort({
    fileAccess: ports.fileAccess,
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
    requireWritableThread: (threadId) =>
      requireWritableThread((id) => lockThreadAndWorks(ports.db, id), threadId),
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
    backgroundTasks,
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
      turns: ports.threadRepos.turns,
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
    backgroundTasks,
    shutdown,
    summarizer: createConversationSummarizer({
      gateway: ports.gateway,
      eventSink: ports.eventSink,
      agentRevisions: ports.agentRevisions,
      prefixCacheStateFor: createPrefixCacheStateService({ repos: ports.threadRepos })
        .prefixCacheStateFor,
      modelRequestDebug: ports.modelRequestDebug,
      toolRegistry,
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
    wakeIfRunnable,
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
    backgroundTasks,
    repos: ports.threadRepos,
    eventWriter: threadEventHub,
    eventSink: ports.eventSink,
    threadLock,
    runClaim: ports.runClaim,
    shutdown,
    wakeIfRunnable,
    billingUsage: ports.billingUsage,
    toolRegistry,
    generate: ({ destination, seed, signal }) =>
      generateHandoffBrief(orchestratorDeps, destination, seed, signal),
    publishStatus: publishThreadStatus,
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
    }),
    documentSync: ports.documentSync,
    contextPorts: ports.contextPorts,
    contextCatalog: ports.contextCatalog,
    contextCatalogRefresh: ports.contextCatalog,
    projectContextAvailability: ports.projectContextAvailability,
    documentAddresses: ports.documentAddresses,
    contextCatalogWakeHub: ports.contextCatalogWakeHub,
    documentLinks: ports.documentLinks,
    linkUpdates: ports.linkUpdates,
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
    stopThreadRun,
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
    fileAccess: ports.fileAccess,
    fileAccessChanges: ports.fileAccessChanges,
    notices: ports.notices,
    changeTrails,
    changeTrailDelivery,
    async shutdown() {
      runner.beginShutdown();
      handoffBriefs.beginShutdown();
      ports.documentSync.dispose();
      await ports.linkUpdates.stop();
      await ports.documentSync.documentDerivations.stop();
      const timeoutMs = APP_DRAIN_DEADLINE_MS;
      const drained = await backgroundTasks.drain(timeoutMs);
      if (!drained)
        emitEvent(ports.eventSink, {
          level: "warn",
          source: "runtime.background-work",
          name: "shutdown.drain_timed_out",
          payload: {
            pendingCount: backgroundTasks.pendingCount,
            pendingTasks: backgroundTasks.pendingTasks,
            timeoutMs,
          },
        });
    },
  };
}

export function createInMemoryAppServices(): AppServices {
  const backgroundTasks = createDetachedWorkTracker();
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
  const runClaim = createInMemoryRunClaim();
  const runStarter = createInMemoryRunStarter();
  const delivery = createInMemoryRuntimeDelivery({
    backgroundTasks,
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
    async hold() {
      return null;
    },
    launchAfterCommit() {},
    async stop() {
      return false;
    },
    async retry() {
      throw new Error("in-memory handoff retry is not implemented");
    },
    beginShutdown() {},
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
    async purgeWorks() {
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
    linkUpdates: { sweep: async () => 0, kick() {}, stop: async () => {} },
    contextPorts: createInMemoryUnifiedContextPortFactory({ documentSync }),
    contextCatalog,
    contextCatalogRefresh: {
      async refreshProjectDocuments() {
        throw new Error("Project document catalog refresh is unavailable in memory");
      },
    },
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
      async retryReply() {
        throw new Error("in-memory reply retry is not implemented");
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
      beginShutdown() {},
      async startDrain() {
        throw new Error("in-memory turn runner is not implemented");
      },
      async cancel() {
        return "not_found" as const;
      },
    },
    async stopThreadRun() {},
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
    fileAccess: createAllowAllFileAccess(),
    fileAccessChanges: createLocalFileAccessChanges(),
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
    async shutdown() {
      await backgroundTasks.drain();
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
