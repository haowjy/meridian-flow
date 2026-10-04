/**
 * Nitro startup plugin: installs the process crash policy and runs config
 * validation at boot, logging warnings through the process EventSink.
 */
import { emitEvent } from "../domains/observability";
import {
  closeAppResources,
  drainAppBackgroundWork,
  drainAppServices,
  getApp,
  stopAppBackgroundWork,
} from "../lib/app";
import { validateAuthConfiguration } from "../lib/auth";
import { createEventSinkFromEnv } from "../lib/event-sink-factory";
import { stopHttpRequestAdmission, waitForHttpRequestDrain } from "../lib/http-drain";
import { getOrBindProcessObservability } from "../lib/observability";
import { installApiProcessCrashPolicy } from "../lib/process-crash-policy";
import {
  installProcessShutdownHooks,
  type ShutdownStep,
  SRVX_FORCE_CLOSE_SECONDS,
} from "../lib/process-shutdown";
import { assertApiStartupGuards, exitOnStartupGuardFailure } from "../lib/startup-guards";

// srvx owns listener closure; its fallback remains later than our global shutdown deadline.
const srvxShutdownTimeout = Number.parseInt(process.env.SERVER_SHUTDOWN_TIMEOUT ?? "", 10);
if (!Number.isFinite(srvxShutdownTimeout) || srvxShutdownTimeout < SRVX_FORCE_CLOSE_SECONDS) {
  process.env.SERVER_SHUTDOWN_TIMEOUT = String(SRVX_FORCE_CLOSE_SECONDS);
}

const eventSink = getOrBindProcessObservability(createEventSinkFromEnv).sink;
installApiProcessCrashPolicy({ eventSink });
const shutdownSteps: ShutdownStep[] = [
  {
    stage: "websocket-admission",
    callback: async () => {
      const [yjs, threads] = await Promise.all([
        import("../routes/ws/yjs"),
        import("../routes/api/threads/ws"),
      ]);
      const errors: unknown[] = [];
      try {
        threads.stopAcceptingThreadWebSockets();
      } catch (error) {
        errors.push(error);
      }
      try {
        yjs.stopAcceptingYjsWebSockets();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0)
        throw new AggregateError(errors, "Websocket admission could not stop cleanly.");
    },
  },
  {
    stage: "polling-loops",
    callback: async () => {
      stopAppBackgroundWork();
      await drainAppBackgroundWork();
    },
  },
  { stage: "application-drain", callback: drainAppServices },
  {
    stage: "http-drain",
    callback: async () => {
      stopHttpRequestAdmission();
      await waitForHttpRequestDrain();
    },
  },
  {
    stage: "websocket-drain",
    callback: async () => {
      const [yjs, threads] = await Promise.all([
        import("../routes/ws/yjs"),
        import("../routes/api/threads/ws"),
      ]);
      await yjs.shutdownYjsWebSockets();
      threads.shutdownThreadWebSockets();
    },
  },
  { stage: "database-close", callback: closeAppResources },
];
installProcessShutdownHooks(eventSink, shutdownSteps);

export default async function startupPlugin() {
  let guards: Awaited<ReturnType<typeof assertApiStartupGuards>>;
  try {
    guards = await assertApiStartupGuards();
  } catch (error) {
    await exitOnStartupGuardFailure(error, { eventSink });
    return;
  }
  const { warnings, replicaCount, durableEventBackend } = guards;
  for (const warning of warnings) {
    emitEvent(eventSink, {
      level: "warn",
      source: "plugins.startup",
      name: "startup_guard.warning",
      payload: { warning },
    });
  }

  const { getYjsGateway } = await import("../routes/ws/yjs");
  getYjsGateway(await getApp());

  // Fail fast in dev and prod — WorkOS credentials are required, not deferred to first request.
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
