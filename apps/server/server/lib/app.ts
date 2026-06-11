import { createDocumentSyncService } from "../domains/collab/index.js";
import { createProductionContextPortFactory } from "../domains/context/index.js";
import {
  createDrizzleProjectRepository,
  createDrizzleWorkRepository,
} from "../domains/projects/index.js";
import { createGatewayFromEnv, type Gateway } from "../domains/runtime/index.js";
import { createRuntimeToolRegistry } from "../domains/runtime/tool-registry.js";
import {
  createDrizzleEventJournalReader,
  createDrizzleEventJournalWriter,
  createDrizzleRepositories,
  createThreadEventHub,
  createThreadRuntimeService,
} from "../domains/threads/index.js";
import {
  type AppServices,
  composeAppServices,
  createInMemoryAppServices,
  createProductionAppPorts,
} from "./compose.js";
import { getDb } from "./db.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

let initPromise: Promise<AppServices> | undefined;

async function createAppServices(): Promise<AppServices> {
  const inMemory = createInMemoryAppServices();
  const { gateway } = await createGatewayFromEnv();
  const db = getDb();
  const journalReader = createDrizzleEventJournalReader(db);
  const journalWriter = createDrizzleEventJournalWriter(db);
  const threadEventHub = createThreadEventHub({ journalReader, journalWriter });
  const documentSync = createDocumentSyncService({ db });
  const contextPorts = createProductionContextPortFactory({ db, documentSync });
  const tools = createRuntimeToolRegistry({ db, contextPorts });

  return composeAppServices(
    createProductionAppPorts({
      ...inMemory,
      gateway,
      threadRepos: createDrizzleRepositories(db),
      journalReader,
      journalWriter,
      threadEventHub,
      threadRuntime: createThreadRuntimeService({ db, gateway, hub: threadEventHub, tools }),
      documentSync,
      contextPorts,
      projects: createDrizzleProjectRepository(db),
      works: createDrizzleWorkRepository(db),
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
