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
  emitEvent,
} from "../domains/observability/index.js";

const OBSERVABILITY_KEY = Symbol.for("meridian.api.observability.v1");

type ShutdownCallback = { name: string; callback: () => Promise<void> | void };
type ObservabilityGlobal = typeof globalThis & {
  [OBSERVABILITY_KEY]?: {
    sink: DeferredEventSink;
    correlatedSink: CorrelatingEventSink;
    eventQuery?: EventQuery;
    delegateBound: boolean;
    shutdownInstalled: boolean;
    shutdownCallbacks: ShutdownCallback[];
  };
};

export async function runShutdownSteps(
  steps: readonly ShutdownCallback[],
  runStep: (step: ShutdownCallback) => Promise<boolean>,
): Promise<void> {
  for (const step of steps) {
    if (!(await runStep(step))) return;
  }
}

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

export function registerProcessShutdownCallback(
  name: string,
  callback: () => Promise<void> | void,
): void {
  state().shutdownCallbacks.push({ name, callback });
}

export function installObservabilityShutdownHooks(): void {
  const current = state();
  if (current.shutdownInstalled) return;
  current.shutdownInstalled = true;

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const deadline = Date.now() + 25_000;
      let failed = false;
      await runShutdownSteps(current.shutdownCallbacks, async ({ name, callback }) => {
        emitEvent(current.sink, {
          level: "info",
          source: "process.shutdown",
          name: `shutdown.${name}.started`,
          payload: { signal },
        });
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          failed = true;
          emitEvent(current.sink, {
            level: "error",
            source: "process.shutdown",
            name: `shutdown.incomplete.${name}`,
            payload: { signal, reason: "deadline" },
          });
          return false;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          Promise.resolve()
            .then(callback)
            .then(
              () => ({ ok: true as const }),
              (cause) => ({ ok: false as const, cause }),
            ),
          new Promise<{ ok: false; timeout: true }>((resolve) => {
            timer = setTimeout(() => resolve({ ok: false, timeout: true }), remaining);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if ("timeout" in result) {
          failed = true;
          emitEvent(current.sink, {
            level: "error",
            source: "process.shutdown",
            name: `shutdown.incomplete.${name}`,
            payload: { signal, reason: "deadline" },
          });
          return false;
        }
        if (!result.ok) {
          failed = true;
          emitEvent(current.sink, {
            level: "error",
            source: "process.shutdown",
            name: `shutdown.step_failed.${name}`,
            payload: { signal, error: String(result.cause) },
          });
        } else {
          emitEvent(current.sink, {
            level: "info",
            source: "process.shutdown",
            name: `shutdown.${name}.completed`,
            payload: { signal },
          });
        }
        return true;
      });
      try {
        await current.sink.flush();
      } catch (cause) {
        failed = true;
        process.stderr.write(`shutdown observability flush failed: ${String(cause)}\n`);
      }
      process.exit(failed ? 1 : 0);
    })();
    return shutdownPromise;
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
