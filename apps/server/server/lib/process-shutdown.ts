/** Owns the ordered process shutdown plan, deadlines, and process exit. */
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";

export const PROCESS_SHUTDOWN_DEADLINE_MS = 25_000;
export const OBSERVABILITY_FLUSH_BUDGET_MS = 4_000;
export const SRVX_FORCE_CLOSE_SECONDS = 29;
export const WEBSOCKET_DRAIN_RESERVED_MS = 4_000;

export const SHUTDOWN_PLAN = [
  { stage: "websocket-admission", budgetMs: 500 },
  { stage: "polling-loops", budgetMs: 3_000 },
  { stage: "application-drain", budgetMs: 10_000 },
  { stage: "http-drain", budgetMs: 2_000 },
  { stage: "websocket-drain", budgetMs: WEBSOCKET_DRAIN_RESERVED_MS },
  { stage: "database-close", budgetMs: 500 },
] as const;

export type ShutdownStage = (typeof SHUTDOWN_PLAN)[number]["stage"];
export type ShutdownStep = {
  stage: ShutdownStage;
  callback: () => Promise<void> | void;
};

const plannedBudgetMs = SHUTDOWN_PLAN.reduce((total, step) => total + step.budgetMs, 0);
if (plannedBudgetMs + OBSERVABILITY_FLUSH_BUDGET_MS > PROCESS_SHUTDOWN_DEADLINE_MS) {
  throw new Error("Shutdown stage and observability budgets exceed the process deadline");
}
if (PROCESS_SHUTDOWN_DEADLINE_MS >= SRVX_FORCE_CLOSE_SECONDS * 1_000) {
  throw new Error("srvx force-close must remain later than the process shutdown deadline");
}

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

function budgetFor(stage: ShutdownStage): number {
  const planned = SHUTDOWN_PLAN.find((step) => step.stage === stage);
  if (!planned) throw new Error(`Shutdown stage is not in the plan: ${stage}`);
  return planned.budgetMs;
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
      name: `shutdown.${step.stage}.started`,
      payload: { signal: input.signal },
    });
    const result = await withDeadline(step.callback, Date.now() + budgetFor(step.stage));
    if (result.status === "deadline") {
      failed = true;
      emitEvent(input.eventSink, {
        level: "error",
        source: "process.shutdown",
        name: `shutdown.incomplete.${step.stage}`,
        payload: { signal: input.signal, reason: "deadline" },
      });
      continue;
    }
    if (result.status === "failed") {
      failed = true;
      emitEvent(input.eventSink, {
        level: "error",
        source: "process.shutdown",
        name: `shutdown.step_failed.${step.stage}`,
        payload: { signal: input.signal, ...unknownToEventPayload(result.error) },
      });
      continue;
    }
    emitEvent(input.eventSink, {
      level: "info",
      source: "process.shutdown",
      name: `shutdown.${step.stage}.completed`,
      payload: { signal: input.signal },
    });
  }
  return failed;
}

let installed = false;

export function assertShutdownStepOrder(steps: readonly ShutdownStep[]): void {
  const order = new Map(SHUTDOWN_PLAN.map((step, index) => [step.stage, index]));
  for (let index = 1; index < steps.length; index += 1) {
    if ((order.get(steps[index - 1].stage) ?? -1) >= (order.get(steps[index].stage) ?? -1)) {
      throw new Error("Shutdown steps must be unique and follow SHUTDOWN_PLAN order");
    }
  }
}

export function installProcessShutdownHooks(
  eventSink: EventSink,
  steps: readonly ShutdownStep[],
): void {
  assertShutdownStepOrder(steps);
  if (installed) return;
  installed = true;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) {
      process.exit(1);
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      const deadlineAt = Date.now() + PROCESS_SHUTDOWN_DEADLINE_MS;
      const sequence = (async () => {
        let failed = await runShutdownSteps(steps, { eventSink, signal });
        const flush = await withDeadline(
          () => eventSink.flush(),
          Date.now() + OBSERVABILITY_FLUSH_BUDGET_MS,
        );
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
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
