import { createDrizzleSubscriptionStore } from "../domains/billing/adapters/drizzle/subscription-store.js";
import {
  createDrizzleCreditLedger,
  createFreeGrantPipeline,
  createGrantingCreditLedger,
} from "../domains/billing/index.js";
import { createPaymentProviderFromEnv } from "../domains/billing/payment-provider-factory.js";
import { createDocumentSyncService } from "../domains/collab/index.js";
import {
  createCheckpointArtifactFlush,
  createCorpusImportService,
  createDriveCorpusImportService,
  createDrizzleFigureDocumentRepository,
  createDrizzleResultRepository,
  createDrizzleThreadUploadDocumentStore,
  createFigureAssetService,
  createFixtureDriveImportSource,
  createMammothDocumentConverter,
  createProductionUnifiedContextPortFactory,
  createPromotionService,
  createThreadUploadImportService,
} from "../domains/context/index.js";
import { emitEvent } from "../domains/observability/index.js";
import { createOnboardingService } from "../domains/onboarding/index.js";
import {
  createDefaultPackageSeeder,
  createDrizzlePackageStore,
  createGitHubMarsPackageFetcher,
  defaultPackageSeedConfigFromEnv,
} from "../domains/packages/index.js";
import { createDrizzleProjectPreferencesRepository } from "../domains/preferences/index.js";
import {
  createDrizzleProjectBootstrapRepository,
  createDrizzleProjectRepository,
  createDrizzleProjectWorkRepository,
  createDrizzleUserRepository,
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
  resolveProfile,
} from "../domains/runtime/index.js";
import { createCheckpointRegistry } from "../domains/runtime/loop/checkpoints.js";
import { createModelRequestDebugStoreFromEnv } from "../domains/runtime/model-request-debug/index.js";
import { createRuntimeToolRegistry } from "../domains/runtime/tool-registry.js";
import { createDrizzleEventJournalReader } from "../domains/threads/adapters/drizzle/event-reader.js";
import { createDrizzleEventJournalWriter } from "../domains/threads/adapters/drizzle/event-writer.js";
import { createDrizzleRepositories } from "../domains/threads/adapters/drizzle/index.js";
import { createThreadRuntimeService } from "../domains/threads/runtime-service.js";
import { createThreadEventHub } from "../domains/threads/thread-event-hub.js";
import {
  type AppServices,
  composeAppServices,
  createInMemoryAppServices,
  createProductionAppPorts,
} from "./compose.js";
import { getDb } from "./db.js";
import { createDrizzleDocumentAccess } from "./document-access.js";
import { createEventSinkFromEnv } from "./event-sink-factory.js";
import { createObjectStoreFromEnv } from "./object-store-factory.js";
import { createWiredCoreToolRegistrations } from "./wired-core-tools.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

let initPromise: Promise<AppServices> | undefined;

async function createAppServices(): Promise<AppServices> {
  const inMemory = createInMemoryAppServices();
  const eventSink = createEventSinkFromEnv();
  const { gateway } = await createGatewayFromEnv(process.env, {
    onWarning: (span) => {
      emitEvent(eventSink, {
        level: "warn",
        source: "gateway",
        name: span.name,
        payload: span.attributes ?? {},
      });
    },
  });
  const db = getDb();
  const threadRepos = createDrizzleRepositories(db);
  const journalReader = createDrizzleEventJournalReader(db);
  const journalWriter = createDrizzleEventJournalWriter(db);
  const { objectStore, localObjectStore } = createObjectStoreFromEnv();
  const threadEventHub = createThreadEventHub({ journalReader, journalWriter, eventSink });
  const documentSync = createDocumentSyncService({ db });
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
  const documentAccess = createDrizzleDocumentAccess(db);
  const contextPorts = createProductionUnifiedContextPortFactory({ db, documentSync });
  const corpusImports = createCorpusImportService({
    contextPorts,
    converter: createMammothDocumentConverter(),
  });
  const driveCorpusImports = createDriveCorpusImportService({
    source: createFixtureDriveImportSource(),
    imports: corpusImports,
  });
  const tools = createRuntimeToolRegistry({
    db,
    contextPorts,
    threads: threadRepos.threads,
    threadWorks: threadRepos.threadWorks,
  });
  const packageRepository = createDrizzlePackageStore({ db });
  const marsPackageFetcher = createGitHubMarsPackageFetcher({
    githubToken: process.env.GITHUB_TOKEN,
  });
  const defaultPackageSeeder = createDefaultPackageSeeder({
    repository: packageRepository,
    fetcher: marsPackageFetcher,
    config: defaultPackageSeedConfigFromEnv(process.env),
  });
  const preferences = createDrizzleProjectPreferencesRepository({ db });
  const projectRepo = createDrizzleProjectRepository({ db });
  const users = createDrizzleUserRepository({ db });
  const projects = createDrizzleProjectBootstrapRepository(db);
  const onboarding = createOnboardingService({ users, projects, projectRepo });
  const workRepo = createDrizzleProjectWorkRepository({ db });
  const baseCreditLedger = createDrizzleCreditLedger(db);
  const creditLedger = createGrantingCreditLedger({
    ledger: baseCreditLedger,
    grants: createFreeGrantPipeline({ ledger: baseCreditLedger }),
  });
  const paymentProvider = createPaymentProviderFromEnv(process.env);
  const subscriptionStore = createDrizzleSubscriptionStore(db);
  const checkpointRegistry = createCheckpointRegistry();
  const toolRegistry = createToolRegistry();
  for (const registration of createWiredCoreToolRegistrations({
    threads: threadRepos.threads,
    contextPorts,
    threadWorks: threadRepos.threadWorks,
    documentTouches: threadRepos.documentTouches,
    eventSink,
  })) {
    toolRegistry.register(registration);
  }
  toolRegistry.register(
    createInvokeToolRegistration({
      packageRepository,
      async findThreadById(threadId: string) {
        const thread = await threadRepos.threads.findById(threadId);
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
    repos: { turns: threadRepos.turns },
    eventSink,
    helperResultDelivery: {
      async flush(threadId) {
        await helperResultDelivery?.flush(threadId);
      },
    },
  });
  helperResultDelivery = createHelperResultDelivery({
    repos: threadRepos,
    eventWriter: threadEventHub,
    getRunningTurnId: (threadId) => runner.getRunningTurnId(threadId),
  });
  const childRunCoordinator = createChildRunCoordinator({
    orchestrator: runTurnProxy,
    repos: {
      threads: threadRepos.threads,
      subagentThreads: threadRepos.threads,
      turns: threadRepos.turns,
      blocks: threadRepos.blocks,
      transaction: threadRepos.transaction,
      threadWorks: threadRepos.threadWorks,
    },
    resolveWorkMembership: async (input) => {
      const { resolveWorkMembership } = await import("./work-attachment.js");
      return resolveWorkMembership(
        { workRepo, threadWorks: threadRepos.threadWorks, threads: threadRepos.threads },
        input,
      );
    },
    eventWriter: threadEventHub,
    packageRepository,
    childRunRegistry: runner.childRunRegistry,
    helperResultDelivery,
    creditLedger,
  });
  const modelRequestDebug = createModelRequestDebugStoreFromEnv();
  const orchestrator = createOrchestrator({
    gateway,
    toolExecutor,
    repos: threadRepos,
    eventWriter: threadEventHub,
    packageRepository,
    toolRegistry,
    projectPreferences: preferences,
    permissionGate: createPermissionGate(computeEffectivePermissions(resolveProfile("coding"))),
    childRunCoordinator,
    helperResultDelivery,
    checkpointRegistry,
    creditLedger,
    checkpointArtifacts: createCheckpointArtifactFlush({
      promotion: promotionService,
      objectStore,
    }),
    eventSink,
    modelRequestDebug,
    openRouterReconcile: process.env.OPENROUTER_API_KEY
      ? {
          apiKey: process.env.OPENROUTER_API_KEY,
          baseUrl: process.env.OPENROUTER_BASE_URL,
        }
      : undefined,
  });
  runTurnProxy.bind(orchestrator);

  return composeAppServices(
    createProductionAppPorts({
      ...inMemory,
      gateway,
      threadRepos,
      repos: threadRepos,
      journalReader,
      journalWriter,
      hub: threadEventHub,
      threadEventHub,
      eventSink,
      threadRuntime: createThreadRuntimeService({ db, gateway, hub: threadEventHub, tools }),
      documentSync,
      contextPorts,
      corpusImports,
      driveCorpusImports,
      onboarding,
      projects,
      works: workRepo,
      projectRepo,
      users,
      workRepo,
      creditLedger,
      paymentProvider,
      subscriptionStore,
      checkpointRegistry,
      packageRepository,
      marsPackageFetcher,
      defaultPackageSeeder,
      async seedDefaultPackagesForProject(projectId: string) {
        await defaultPackageSeeder.seedProject(projectId);
      },
      preferences,
      orchestrator,
      runner,
      toolRegistry,
      toolExecutor,
      modelRequestDebug,
      objectStore,
      localObjectStore,
      uploadDocuments,
      threadUploadImports,
      figureAssets,
      results,
      documentAccess,
    }),
  );
}

export type { AppServices, ThreadRepositories } from "./compose.js";
export {
  composeAppServices,
  createInMemoryAppServices,
  createProductionAppPorts,
} from "./compose.js";

export async function getApp(): Promise<AppServices> {
  const globalStore = globalThis as AppGlobal;
  if (!initPromise) {
    initPromise = globalStore[APP_SINGLETON_KEY] ?? createAppServices();
    globalStore[APP_SINGLETON_KEY] = initPromise;
  }
  return initPromise;
}

export type { Gateway };
