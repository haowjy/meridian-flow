/**
 * Nitro startup plugin: installs the process crash policy (and, outside production, the
 * test hook controller the crash and race probes arm) and runs config validation at
 * boot, logging warnings through the process EventSink.
 */
import { emitEvent, unknownToEventPayload } from "../domains/observability";
import { getApp } from "../lib/app";
import { validateAuthConfiguration } from "../lib/auth";
import { createEventSinkFromEnv } from "../lib/event-sink-factory";
import {
  getOrBindProcessObservability,
  installObservabilityShutdownHooks,
  registerProcessShutdownCallback,
} from "../lib/observability";
import { installApiProcessCrashPolicy } from "../lib/process-crash-policy";
import { assertApiStartupGuards } from "../lib/startup-guards";
import { getYjsGateway } from "../routes/ws/yjs";
import { installTestHookController } from "../shared/test-hook-controller";

const eventSink = getOrBindProcessObservability(createEventSinkFromEnv).sink;
let yjsGateway: ReturnType<typeof getYjsGateway> | undefined;

installApiProcessCrashPolicy({ eventSink });
installTestHookController();
installObservabilityShutdownHooks();

async function boot() {
  const { warnings, replicaCount, durableEventBackend } = await assertApiStartupGuards();
  for (const warning of warnings) {
    emitEvent(eventSink, {
      level: "warn",
      source: "plugins.startup",
      name: "startup_guard.warning",
      payload: { warning },
    });
  }

  yjsGateway = getYjsGateway(await getApp());
  // Shutdown callbacks start together so document persistence gets the full
  // process deadline even when runtime settlement is slow.
  registerProcessShutdownCallback(async () => {
    await yjsGateway?.drain();
  });

  // Fail fast in dev and prod — WorkOS credentials are required, not deferred to first request
  // (skipped when the local dev auth bypass is on).
  await validateAuthConfiguration();

  emitEvent(eventSink, {
    level: "info",
    source: "plugins.startup",
    name: "startup.complete",
    payload: {
      eventDispatch: "process-local",
      apiReplicaCount: replicaCount ?? "unknown",
      durableEventBackend,
    },
  });
}

/**
 * Nitro calls plugins without awaiting them, and the crash policy logs and
 * survives unhandled rejections, so an async plugin's failure would leave a
 * misconfigured server listening. A boot failure must end the process.
 */
export default function startupPlugin() {
  boot().catch((error: unknown) => {
    // The sink may not flush before the exit below; stderr always does.
    console.error("Server startup failed:", error);
    emitEvent(eventSink, {
      level: "error",
      source: "plugins.startup",
      name: "startup.failed",
      payload: unknownToEventPayload(error),
    });
    process.exit(1);
  });
}
