/**
 * App singleton: lazily builds and caches the composed AppServices on a global
 * symbol. App startup supplies process resources; compose owns adapter selection
 * and pure service wiring.
 */
import { type AppServices, composeAppServices, createProductionAppPorts } from "./compose.js";
import { getDb } from "./db.js";
import { createEventSinkFromEnv } from "./event-sink-factory.js";
import { bindProcessEventSink } from "./observability.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

let initPromise: Promise<AppServices> | undefined;

async function createAppServices(): Promise<AppServices> {
  const db = getDb();
  const eventSink = bindProcessEventSink(createEventSinkFromEnv());
  const ports = await createProductionAppPorts({ db, eventSink, environment: process.env });
  return composeAppServices(ports);
}

export type { Gateway } from "../domains/runtime/index.js";
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
