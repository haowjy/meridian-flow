/**
 * Process-scoped observability bootstrap. Startup, crash policy, and app
 * composition all share this one deferred sink so buffered backends do not split
 * diagnostics across independent queues or lose early boot events.
 */
import {
  DeferredEventSink,
  type EventQuery,
  type EventSink,
} from "../domains/observability/index.js";

const OBSERVABILITY_KEY = Symbol.for("meridian.api.observability.v1");

type ObservabilityGlobal = typeof globalThis & {
  [OBSERVABILITY_KEY]?: {
    sink: DeferredEventSink;
    eventQuery?: EventQuery;
    delegateBound: boolean;
    shutdownInstalled: boolean;
    shutdownCallbacks: Array<() => Promise<void> | void>;
  };
};

function state() {
  const store = globalThis as ObservabilityGlobal;
  store[OBSERVABILITY_KEY] ??= {
    sink: new DeferredEventSink(),
    delegateBound: false,
    shutdownInstalled: false,
    shutdownCallbacks: [],
  };
  return store[OBSERVABILITY_KEY];
}

export function getProcessEventSink(): EventSink {
  return state().sink;
}

export function getOrBindProcessObservability(
  createDelegate: () => {
    sink: EventSink;
    eventQuery?: EventQuery;
  },
): { sink: EventSink; eventQuery?: EventQuery } {
  const current = state();
  if (!current.delegateBound) {
    const delegate = createDelegate();
    current.sink.bind(delegate.sink);
    current.eventQuery = delegate.eventQuery;
    current.delegateBound = true;
  }
  return {
    sink: current.sink,
    ...(current.eventQuery !== undefined && { eventQuery: current.eventQuery }),
  };
}

export function registerProcessShutdownCallback(callback: () => Promise<void> | void): void {
  state().shutdownCallbacks.push(callback);
}

export function installObservabilityShutdownHooks(): void {
  const current = state();
  if (current.shutdownInstalled) return;
  current.shutdownInstalled = true;
  const flush = async () => {
    for (const callback of current.shutdownCallbacks) {
      await Promise.resolve(callback()).catch(() => undefined);
    }
    await current.sink.flush().catch(() => undefined);
  };
  process.once("SIGTERM", () => void flush().finally(() => process.exit(0)));
  process.once("SIGINT", () => void flush().finally(() => process.exit(0)));
}
