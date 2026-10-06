/**
 * App singleton: lazily builds and caches the composed AppServices on a global
 * symbol. App startup supplies process resources; compose owns adapter selection
 * and pure service wiring.
 */

import { listenForThreadEvents } from "../domains/threads/adapters/drizzle/event-relay.js";
import { type AppServices, composeAppServices, createProductionAppPorts } from "./compose.js";
import { getDb } from "./db.js";
import { resolveWakeSweepIntervalMs } from "./env.js";
import { createEventSinkFromEnv } from "./event-sink-factory.js";
import { getOrBindProcessObservability, registerProcessShutdownCallback } from "./observability.js";
import { startRecoveryScheduler } from "./recovery-scheduler.js";

const APP_SINGLETON_KEY = Symbol.for("meridian.app.v1");

type AppGlobal = typeof globalThis & {
  [APP_SINGLETON_KEY]?: Promise<AppServices>;
};

const CHANGE_TRAIL_POLL_MS = 1_000;
const SYSTEM_UPDATE_SWEEP_MS = 1_000;
const WORK_PURGE_INTERVAL_MS = 60 * 60 * 1_000;
const WAKE_SWEEP_INTERVAL_MS = resolveWakeSweepIntervalMs(process.env.WAKE_SWEEP_INTERVAL_MS);

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
  await listenForThreadEvents({
    db,
    eventHub: app.threadEventHub,
    eventSink,
  });
  const scheduler = startRecoveryScheduler(
    [
      { name: "wake-scan", delayMs: WAKE_SWEEP_INTERVAL_MS, run: app.recovery.scanWakes },
      { name: "orphan-repair", delayMs: WAKE_SWEEP_INTERVAL_MS, run: app.recovery.repairOrphans },
      { name: "work-purge", delayMs: WORK_PURGE_INTERVAL_MS, run: app.recovery.purgeWorks },
      {
        name: "report-publication",
        delayMs: WAKE_SWEEP_INTERVAL_MS,
        run: app.recovery.publishReports,
      },
      {
        name: "work-notices",
        delayMs: SYSTEM_UPDATE_SWEEP_MS,
        run: app.workContextNotices.sweepWorkNotices,
      },
      {
        name: "document-derivations",
        delayMs: 10000,
        run: app.documentSync.documentDerivations.sweep,
      },
      { name: "link-updates", delayMs: SYSTEM_UPDATE_SWEEP_MS, run: app.linkUpdates.sweep },
      { name: "change-trail", delayMs: CHANGE_TRAIL_POLL_MS, run: app.changeTrailDelivery.drain },
    ],
    eventSink,
  );
  registerProcessShutdownCallback(async () => {
    await Promise.all([scheduler.stop(), app.shutdown()]);
  });
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
