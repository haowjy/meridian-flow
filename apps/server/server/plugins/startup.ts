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
import {
  getOrBindProcessObservability,
  installObservabilityShutdownHooks,
  registerProcessShutdownCallback,
} from "../lib/observability";
import { installApiProcessCrashPolicy } from "../lib/process-crash-policy";
import { assertApiStartupGuards } from "../lib/startup-guards";

const eventSink = getOrBindProcessObservability(createEventSinkFromEnv).sink;
installApiProcessCrashPolicy({ eventSink });
registerProcessShutdownCallback("websocket-admission", async () => {
  const [yjs, threads] = await Promise.all([
    import("../routes/ws/yjs"),
    import("../routes/api/threads/ws"),
  ]);
  yjs.stopAcceptingYjsWebSockets();
  threads.stopAcceptingThreadWebSockets();
});
registerProcessShutdownCallback("polling-loops", async () => {
  stopAppBackgroundWork();
  await drainAppBackgroundWork();
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
installObservabilityShutdownHooks();

export default async function startupPlugin() {
  const { warnings, replicaCount, durableEventBackend } = await assertApiStartupGuards();
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
