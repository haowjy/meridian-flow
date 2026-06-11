import { createGatewayFromEnv, type Gateway } from "../domains/runtime/index.js";
import {
  type AppServices,
  composeAppServices,
  createInMemoryAppServices,
  createProductionAppPorts,
} from "./compose.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

let initPromise: Promise<AppServices> | undefined;

async function createAppServices(): Promise<AppServices> {
  const inMemory = createInMemoryAppServices();
  const { gateway } = await createGatewayFromEnv();

  return composeAppServices(
    createProductionAppPorts({
      ...inMemory,
      gateway,
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
