/**
 * App singleton: lazily builds and caches the composed AppServices on a global
 * symbol. App startup supplies process resources; compose owns adapter selection
 * and pure service wiring.
 */
import { type AppServices, composeAppServices, createProductionAppPorts } from "./compose.js";
import { getDb } from "./db.js";
import { createEventSinkFromEnv } from "./event-sink-factory.js";
import { getOrBindProcessEventSink } from "./observability.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

const CHANGE_TRAIL_POLL_MS = 1_000;

let initPromise: Promise<AppServices> | undefined;

async function createAppServices(): Promise<AppServices> {
  const db = getDb();
  const eventSink = getOrBindProcessEventSink(createEventSinkFromEnv);
  const ports = await createProductionAppPorts({ db, eventSink, environment: process.env });
  const app = composeAppServices(ports);
  const drain = () => void app.changeTrailDelivery.drain().catch(() => undefined);
  drain();
  // Polling is the recovery mechanism as well as the trigger: committed pushes need
  // no in-process callback to survive a crash or a different server process.
  setInterval(drain, CHANGE_TRAIL_POLL_MS).unref();
  return app;
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
