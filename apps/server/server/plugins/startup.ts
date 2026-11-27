import { isMainThread } from "node:worker_threads";
import { emitEvent, unknownToEventPayload } from "../domains/observability";
import { getApp } from "../lib/app";
import { validateAuthConfiguration } from "../lib/auth";
import { createEventSinkFromEnv } from "../lib/event-sink-factory";
import {
  getOrBindProcessObservability,
  installObservabilityShutdownHooks,
  registerProcessShutdownCallback,
} from "../lib/observability";
import { installOutboundHttp1 } from "../lib/outbound-http1";
import { installApiProcessCrashPolicy } from "../lib/process-crash-policy";
import { assertApiStartupGuards } from "../lib/startup-guards";
import { getLoroGateway } from "../routes/ws/loro";
import { installTestHookController } from "../shared/test-hook-controller";

const eventSink = getOrBindProcessObservability(createEventSinkFromEnv).sink;
let loroGateway: ReturnType<typeof getLoroGateway> | undefined;

installOutboundHttp1();
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

  loroGateway = getLoroGateway(await getApp());
  registerProcessShutdownCallback(async () => {
    await loroGateway?.drain();
  });

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

// Nitro does not await plugins and the crash policy survives rejections, so a failed boot must exit a built server; in `nitro dev` the worker stays up instead, which Nitro would restart without limit
export default function startupPlugin() {
  boot().catch(async (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`Server startup failed: ${detail}\n`);
    try {
      emitEvent(eventSink, {
        level: "error",
        source: "plugins.startup",
        name: "startup.failed",
        payload: unknownToEventPayload(error),
      });
      await eventSink.flush();
    } finally {
      if (isMainThread) process.exit(1);
    }
  });
}
