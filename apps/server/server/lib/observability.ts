/**
 * Process-scoped observability bootstrap. Startup, crash policy, and app
 * composition all share this one deferred sink so buffered backends do not split
 * diagnostics across independent queues or lose early boot events.
 */
import {
  CorrelatingEventSink,
  DeferredEventSink,
  type EventQuery,
  type EventSink,
} from "../domains/observability/index.js";

const OBSERVABILITY_KEY = Symbol.for("meridian.api.observability.v1");

type ObservabilityGlobal = typeof globalThis & {
  [OBSERVABILITY_KEY]?: {
    sink: DeferredEventSink;
    correlatedSink: CorrelatingEventSink;
    eventQuery?: EventQuery;
    delegateBound: boolean;
    shutdownInstalled: boolean;
    shutdownPromise?: Promise<void>;
    shutdownCallbacks: Array<() => Promise<void> | void>;
  };
};

function state() {
  const store = globalThis as ObservabilityGlobal;
  if (!store[OBSERVABILITY_KEY]) {
    const sink = new DeferredEventSink();
    store[OBSERVABILITY_KEY] = {
      sink,
      correlatedSink: new CorrelatingEventSink(sink),
      delegateBound: false,
      shutdownInstalled: false,
      shutdownCallbacks: [],
    };
  }
  return store[OBSERVABILITY_KEY];
}

export function getProcessEventSink(): EventSink {
  return state().correlatedSink;
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
    sink: current.correlatedSink,
    ...(current.eventQuery !== undefined && { eventQuery: current.eventQuery }),
  };
}

export function registerProcessShutdownCallback(callback: () => Promise<void> | void): void {
  state().shutdownCallbacks.push(callback);
}

export function shutdownProcessResources(): Promise<void> {
  const current = state();
  current.shutdownPromise ??= (async () => {
    for (const callback of current.shutdownCallbacks) {
      await Promise.resolve()
        .then(callback)
        .catch(() => undefined);
    }
    await current.sink.flush().catch(() => undefined);
  })();
  return current.shutdownPromise;
}

export function installObservabilityShutdownHooks(): void {
  const current = state();
  if (current.shutdownInstalled) return;
  current.shutdownInstalled = true;
  const shutdown = () => {
    // SIGINT and SIGTERM may both arrive while the bounded runtime drain is in
    // flight. They are one shutdown, not competing drain/flush/exit sequences.
    void shutdownProcessResources().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
