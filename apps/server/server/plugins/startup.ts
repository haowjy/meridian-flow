/**
 * Nitro startup plugin: installs the process crash policy and runs config
 * validation at boot, logging warnings through the event sink.
 */
import { emitEvent } from "../domains/observability";
import { createEventSinkFromEnv } from "../lib/event-sink-factory";
import { installApiProcessCrashPolicy } from "../lib/process-crash-policy";
import { assertApiStartupGuards } from "../lib/startup-guards";

const eventSink = createEventSinkFromEnv();

installApiProcessCrashPolicy({ eventSink });

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
