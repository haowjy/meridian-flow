/**
 * App singleton: lazily builds and caches the composed AppServices on a global
 * symbol. App startup supplies process resources; compose owns adapter selection
 * and pure service wiring.
 */

import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import { listenForThreadEvents } from "../domains/threads/adapters/drizzle/event-relay.js";
import { type AppServices, composeAppServices, createProductionAppPorts } from "./compose.js";
import { closeDb, getDb } from "./db.js";
import { createEventSinkFromEnv } from "./event-sink-factory.js";
import { getOrBindProcessObservability } from "./observability.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

const CHANGE_TRAIL_POLL_MS = 1_000;
const SYSTEM_UPDATE_SWEEP_MS = 1_000;
// Covers deploy overlap: a sweep that skips the old process's live claim retries
// shortly after the platform terminates that process.
const ORPHANED_TURN_SWEEP_MS = 20_000;

let initPromise: Promise<AppServices> | undefined;
const intervalHandles: ReturnType<typeof setInterval>[] = [];
const activeBackgroundTasks = new Set<Promise<void>>();
let unlistenThreadEvents: (() => Promise<void>) | undefined;
let appResourcesStopped = false;

export function stopAppBackgroundWork(): void {
  for (const interval of intervalHandles.splice(0)) clearInterval(interval);
}

export async function drainAppBackgroundWork(): Promise<void> {
  while (activeBackgroundTasks.size > 0) {
    await Promise.all([...activeBackgroundTasks]);
  }
}

function trackBackgroundTask(task: () => Promise<void>): void {
  let running: Promise<void>;
  running = Promise.resolve()
    .then(task)
    .finally(() => activeBackgroundTasks.delete(running));
  activeBackgroundTasks.add(running);
}

export async function closeAppResources(): Promise<void> {
  if (appResourcesStopped) return;
  appResourcesStopped = true;
  stopAppBackgroundWork();
  try {
    await unlistenThreadEvents?.();
  } finally {
    await closeDb();
  }
}

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
    trackBackgroundTask(async () => {
      try {
        await app.changeTrailDelivery.drain();
      } catch (cause) {
        emitEvent(eventSink, {
          level: "error",
          source: "collab.change-trail-delivery",
          name: "poll.failed",
          payload: unknownToEventPayload(cause),
        });
      }
    });
  const sweepWorkContext = () =>
    trackBackgroundTask(async () => {
      try {
        await app.workContextDelivery.sweep();
      } catch (cause) {
        emitEvent(eventSink, {
          level: "error",
          source: "runtime.work-context-delivery",
          name: "sweep.failed",
          payload: unknownToEventPayload(cause),
        });
      }
    });
  const sweepChildReports = () =>
    trackBackgroundTask(async () => {
      try {
        await app.childReportDelivery.sweep();
      } catch (cause) {
        emitEvent(eventSink, {
          level: "error",
          source: "runtime.child-report-delivery",
          name: "sweep.failed",
          payload: unknownToEventPayload(cause),
        });
      }
    });
  const sweepOrphanedTurns = () =>
    trackBackgroundTask(async () => {
      try {
        await app.orphanedTurnRecovery.sweep();
      } catch (cause) {
        emitEvent(eventSink, {
          level: "error",
          source: "runtime.orphaned-turn-recovery",
          name: "sweep.failed",
          payload: unknownToEventPayload(cause),
        });
      }
    });
  const listener = await listenForThreadEvents({
    db,
    journalReader: app.journalReader,
    eventHub: app.threadEventHub,
    eventSink,
  });
  unlistenThreadEvents = listener.unlisten;
  drain();
  sweepWorkContext();
  sweepChildReports();
  sweepOrphanedTurns();
  // Polling is the recovery mechanism as well as the trigger: committed pushes need
  // no in-process callback to survive a crash or a different server process.
  intervalHandles.push(
    setInterval(drain, CHANGE_TRAIL_POLL_MS),
    setInterval(sweepWorkContext, SYSTEM_UPDATE_SWEEP_MS),
    setInterval(sweepChildReports, SYSTEM_UPDATE_SWEEP_MS),
    setInterval(sweepOrphanedTurns, ORPHANED_TURN_SWEEP_MS),
  );
  for (const interval of intervalHandles) interval.unref();
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
