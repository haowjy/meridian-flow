/**
 * Nitro startup plugin: installs the process crash policy and runs config
 * validation at boot, logging warnings through the process EventSink.
 */
import { emitEvent } from "../domains/observability";
import {
  closeAppResources,
  drainAppBackgroundWork,
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
  POLLING_LOOPS_SHUTDOWN_TIMEOUT_MS,
  registerProcessShutdownCallback,
} from "../lib/process-shutdown";
import { assertApiStartupGuards, exitOnStartupGuardFailure } from "../lib/startup-guards";

// srvx owns listener closure; leave enough time for our 25s application drain
// to finish before its listener-level force-close fallback can run.
const srvxShutdownTimeout = Number.parseInt(process.env.SERVER_SHUTDOWN_TIMEOUT ?? "", 10);
if (!Number.isFinite(srvxShutdownTimeout) || srvxShutdownTimeout <= 25) {
  process.env.SERVER_SHUTDOWN_TIMEOUT = "29";
}

const eventSink = getOrBindProcessObservability(createEventSinkFromEnv).sink;
installApiProcessCrashPolicy({ eventSink });
registerProcessShutdownCallback("websocket-admission", async () => {
  const [yjs, threads] = await Promise.all([
    import("../routes/ws/yjs"),
    import("../routes/api/threads/ws"),
  ]);
  const errors: unknown[] = [];
  try {
    threads.shutdownThreadWebSockets();
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
});
registerProcessShutdownCallback(
  "polling-loops",
  async () => {
    stopAppBackgroundWork();
    await drainAppBackgroundWork();
  },
  { timeoutMs: POLLING_LOOPS_SHUTDOWN_TIMEOUT_MS },
);
registerProcessShutdownCallback(
  "turn-drain",
  async () => {
    await (await getApp()).runner.shutdown();
  },
  { timeoutMs: 8_000 },
);
registerProcessShutdownCallback("http-drain", async () => {
  stopHttpRequestAdmission();
  await waitForHttpRequestDrain(10_000);
});
registerProcessShutdownCallback("websocket-drain", async () => {
  const [yjs, threads] = await Promise.all([
    import("../routes/ws/yjs"),
    import("../routes/api/threads/ws"),
  ]);
  await yjs.shutdownYjsWebSockets();
  threads.shutdownThreadWebSockets();
});
registerProcessShutdownCallback("database-close", closeAppResources);
installProcessShutdownHooks(eventSink);

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
