/** Owns ordered process shutdown stages, their deadlines, and process exit. */
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";

export type ShutdownStep = {
  name: string;
  callback: () => Promise<void> | void;
  timeoutMs?: number;
};

export const POLLING_LOOPS_SHUTDOWN_TIMEOUT_MS = 3_000;

export type DeadlineResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "deadline" };

export async function withDeadline<T>(
  task: () => Promise<T> | T,
  deadlineAt: number,
): Promise<DeadlineResult<T>> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return { status: "deadline" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.resolve()
      .then(task)
      .then(
        (value) => ({ status: "completed" as const, value }),
        (error: unknown) => ({ status: "failed" as const, error }),
      ),
    new Promise<{ status: "deadline" }>((resolve) => {
      timer = setTimeout(() => resolve({ status: "deadline" }), remainingMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  input: { eventSink: EventSink; signal: NodeJS.Signals },
): Promise<boolean> {
  let failed = false;
  for (const step of steps) {
    emitEvent(input.eventSink, {
      level: "info",
      source: "process.shutdown",
      name: `shutdown.${step.name}.started`,
      payload: { signal: input.signal },
    });
    const stageDeadline = Date.now() + (step.timeoutMs ?? 25_000);
    const result = await withDeadline(step.callback, stageDeadline);
    if (result.status === "deadline") {
      failed = true;
      emitEvent(input.eventSink, {
        level: "error",
        source: "process.shutdown",
        name: `shutdown.incomplete.${step.name}`,
        payload: { signal: input.signal, reason: "deadline" },
      });
      continue;
    }
    if (result.status === "failed") {
      failed = true;
      emitEvent(input.eventSink, {
        level: "error",
        source: "process.shutdown",
        name: `shutdown.step_failed.${step.name}`,
        payload: { signal: input.signal, ...unknownToEventPayload(result.error) },
      });
      continue;
    }
    emitEvent(input.eventSink, {
      level: "info",
      source: "process.shutdown",
      name: `shutdown.${step.name}.completed`,
      payload: { signal: input.signal },
    });
  }
  return failed;
}

const shutdownSteps: ShutdownStep[] = [];
let installed = false;

export function registerProcessShutdownCallback(
  name: string,
  callback: () => Promise<void> | void,
  options: { timeoutMs?: number } = {},
): void {
  shutdownSteps.push({ name, callback, ...options });
}

export function installProcessShutdownHooks(eventSink: EventSink): void {
  if (installed) return;
  installed = true;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const deadlineAt = Date.now() + 25_000;
      const sequence = (async () => {
        let failed = await runShutdownSteps(shutdownSteps, {
          eventSink,
          signal,
        });
        const flush = await withDeadline(() => eventSink.flush(), Date.now() + 4_000);
        if (flush.status !== "completed") {
          failed = true;
          const reason = flush.status === "deadline" ? "deadline" : String(flush.error);
          emitEvent(eventSink, {
            level: "error",
            source: "process.shutdown",
            name: "shutdown.incomplete.observability-flush",
            payload: { signal, reason },
          });
          process.stderr.write(`shutdown.incomplete.observability-flush ${reason}\n`);
        }
        return failed;
      })();
      const result = await withDeadline(() => sequence, deadlineAt);
      if (result.status !== "completed") {
        emitEvent(eventSink, {
          level: "error",
          source: "process.shutdown",
          name: "shutdown.incomplete.global-deadline",
          payload: { signal, reason: "deadline" },
        });
        process.stderr.write("shutdown.incomplete.global-deadline\n");
        process.exit(1);
      }
      process.exit(result.value ? 1 : 0);
    })();
    return shutdownPromise;
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
