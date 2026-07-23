/**
 * App singleton: lazily builds and caches the composed AppServices on a global
 * symbol. App startup supplies process resources; compose owns adapter selection
 * and pure service wiring.
 */

import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import { listenForThreadEvents } from "../domains/threads/adapters/drizzle/event-relay.js";
import { type AppServices, composeAppServices, createProductionAppPorts } from "./compose.js";
import { getDb } from "./db.js";
import { createEventSinkFromEnv } from "./event-sink-factory.js";
import { getOrBindProcessObservability } from "./observability.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

const CHANGE_TRAIL_POLL_MS = 1_000;

let initPromise: Promise<AppServices> | undefined;

async function createAppServices(): Promise<AppServices> {
  const db = getDb();
  const observability = getOrBindProcessObservability(createEventSinkFromEnv);
  const eventSink = observability.sink;
  const ports = await createProductionAppPorts({
    db,
    eventSink,
    eventQuery: observability.eventQuery,
    environment: process.env,
  });
  const app = composeAppServices(ports);
  const drain = () =>
    void app.changeTrailDelivery.drain().catch((cause) => {
      emitEvent(eventSink, {
        level: "error",
        source: "collab.change-trail-delivery",
        name: "poll.failed",
        payload: unknownToEventPayload(cause),
      });
    });
  await listenForThreadEvents({
    db,
    journalReader: app.journalReader,
    eventHub: app.threadEventHub,
    eventSink,
  });
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
