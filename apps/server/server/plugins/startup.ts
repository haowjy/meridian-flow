/**
 * Nitro startup plugin: installs the process crash policy and runs config
 * validation at boot, logging warnings through the process EventSink.
 */
import { emitEvent } from "../domains/observability";
import { validateAuthConfiguration } from "../lib/auth";
import { getProcessEventSink, installObservabilityShutdownHooks } from "../lib/observability";
import { installApiProcessCrashPolicy } from "../lib/process-crash-policy";
import { assertApiStartupGuards } from "../lib/startup-guards";

const eventSink = getProcessEventSink();

installApiProcessCrashPolicy({ eventSink });
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
