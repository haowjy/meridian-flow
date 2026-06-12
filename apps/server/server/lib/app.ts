// @ts-nocheck
import { createDrizzleCreditLedger } from "../domains/billing/index.js";
import { createDocumentSyncService } from "../domains/collab/index.js";
import {
  createCheckpointArtifactFlush,
  createDrizzleFigureDocumentRepository,
  createDrizzleResultRepository,
  createDrizzleThreadUploadDocumentStore,
  createFigureAssetService,
  createProductionContextPortFactory,
  createPromotionService,
} from "../domains/context/index.js";
import { createNoopEventSink } from "../domains/observability/index.js";
import {
  createDefaultPackageSeeder,
  createDrizzlePackageStore,
  createGitHubMarsPackageFetcher,
  defaultPackageSeedConfigFromEnv,
} from "../domains/packages/index.js";
import { createInMemoryWorkbenchPreferencesRepository } from "../domains/preferences/index.js";
import {
  createDrizzleProjectRepository,
  createDrizzleWorkRepository,
} from "../domains/projects/index.js";
import {
  computeEffectivePermissions,
  createChildRunCoordinator,
  createGatewayFromEnv,
  createLateBindRunTurnPort,
  createOrchestrator,
  createPermissionGate,
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
  createDrizzleUserRepository,
  createDrizzleWorkbenchRepository,
  createDrizzleWorkRepository as createDrizzleWorkbenchWorkRepository,
} from "../domains/workbenches/index.js";
import {
  type AppServices,
  composeAppServices,
  createInMemoryAppServices,
  createProductionAppPorts,
} from "./compose.js";
import { getDb } from "./db.js";
import { createDrizzleDocumentAccess } from "./document-access.js";
import { createObjectStoreFromEnv } from "./object-store-factory.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

let initPromise: Promise<AppServices> | undefined;

async function createAppServices(): Promise<AppServices> {
  const inMemory = createInMemoryAppServices();
  const { gateway } = await createGatewayFromEnv(process.env);
  const db = getDb();
  const threadRepos = createDrizzleRepositories(db);
  const journalReader = createDrizzleEventJournalReader(db);
  const journalWriter = createDrizzleEventJournalWriter(db);
  const eventSink = createNoopEventSink();
  const { objectStore, localObjectStore } = createObjectStoreFromEnv();
  const threadEventHub = createThreadEventHub({ journalReader, journalWriter, eventSink });
  const documentSync = createDocumentSyncService({ db });
  const uploadDocuments = createDrizzleThreadUploadDocumentStore(db, threadRepos.threadDocuments);
  const figureAssets = createFigureAssetService({
    objectStore,
    documents: createDrizzleFigureDocumentRepository({ db }),
    signedUrlExpiresAt: () => new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    eventSink,
  });
  const results = createDrizzleResultRepository(db);
  const promotionService = createPromotionService({ objectStore, results });
  const documentAccess = createDrizzleDocumentAccess(db);
  const contextPorts = createProductionContextPortFactory({ db, documentSync });
  const tools = createRuntimeToolRegistry({ db, contextPorts });
  const packageRepository = createDrizzlePackageStore({ db });
  const marsPackageFetcher = createGitHubMarsPackageFetcher({
    githubToken: process.env.GITHUB_TOKEN,
  });
  const defaultPackageSeeder = createDefaultPackageSeeder({
    repository: packageRepository,
    fetcher: marsPackageFetcher,
    config: defaultPackageSeedConfigFromEnv(process.env),
  });
  const preferences = createInMemoryWorkbenchPreferencesRepository();
  const workbenchRepo = createDrizzleWorkbenchRepository({ db });
  const users = createDrizzleUserRepository({ db });
  const workRepo = createDrizzleWorkbenchWorkRepository({ db });
  const creditLedger = createDrizzleCreditLedger(db);
  const checkpointRegistry = createCheckpointRegistry();
  const toolRegistry = createToolRegistry();
  const toolExecutor = createToolExecutor(toolRegistry);
  const runTurnProxy = createLateBindRunTurnPort();
  const runner = createTurnRunner({
    orchestrator: runTurnProxy,
    hub: threadEventHub,
    repos: { turns: threadRepos.turns },
    eventSink,
  });
  const childRunCoordinator = createChildRunCoordinator({
    orchestrator: runTurnProxy,
    repos: {
      threads: threadRepos.threads,
      subagentThreads: threadRepos.threads,
      turns: threadRepos.turns,
      blocks: threadRepos.blocks,
    },
    eventWriter: threadEventHub,
    packageRepository,
    childRunRegistry: runner.childRunRegistry,
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
    workbenchPreferences: preferences,
    permissionGate: createPermissionGate(computeEffectivePermissions(resolveProfile("coding"))),
    childRunCoordinator,
    checkpointRegistry,
    creditLedger,
    checkpointArtifacts: createCheckpointArtifactFlush({
      promotion: promotionService,
      objectStore,
    }),
    eventSink,
    modelRequestDebug,
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
      projects: createDrizzleProjectRepository(db),
      works: createDrizzleWorkRepository(db),
      workbenchRepo,
      users,
      workRepo,
      creditLedger,
      checkpointRegistry,
      packageRepository,
      marsPackageFetcher,
      defaultPackageSeeder,
      async seedDefaultPackagesForWorkbench(workbenchId: string) {
        await defaultPackageSeeder.seedWorkbench(workbenchId);
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
