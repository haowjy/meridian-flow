/**
 * Process crash policy: installs global unhandled-rejection (log + survive)
 * and uncaught-exception (log + delayed exit) handlers. Idempotent via a
 * global Symbol singleton guard — calling twice is harmless.
 */
import { type EventSink, emitEvent } from "../domains/observability/index.js";

const PROCESS_CRASH_POLICY_KEY = Symbol.for("meridian.api.process-crash-policy.v1");

type ProcessCrashPolicyGlobal = typeof globalThis & {
  [PROCESS_CRASH_POLICY_KEY]?: true;
};

function describeReason(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
      cause: reason.cause instanceof Error ? describeReason(reason.cause) : reason.cause,
    };
  }

  return { value: reason };
}

function logProcessFault(
  eventSink: EventSink,
  event: "unhandledRejection" | "uncaughtException",
  reason: unknown,
  context: Record<string, unknown>,
): void {
  emitEvent(eventSink, {
    level: "error",
    source: "lib.process-crash-policy",
    name: event === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception",
    payload: {
      pid: process.pid,
      // Read raw, NOT via the validated `env` module, on purpose: this runs on the
      // crash path and must stay dependency-free. `env.ts` calls createEnv() which
      // THROWS on invalid config — if a bad env caused the crash, importing it here
      // would throw again and swallow the diagnostic. A best-effort annotation only.
      nodeEnv: process.env.NODE_ENV,
      reason: describeReason(reason),
      ...context,
    },
  });
}

export function installApiProcessCrashPolicy(options: { eventSink: EventSink }): void {
  const eventSink = options.eventSink;
  const store = globalThis as ProcessCrashPolicyGlobal;
  if (store[PROCESS_CRASH_POLICY_KEY]) return;
  store[PROCESS_CRASH_POLICY_KEY] = true;

  /**
   * Unhandled promise rejections are logged but do NOT crash the process.
   *
   * Node.js 15+ terminates on unhandled rejections by default. This handler
   * overrides that — a solitary rejected promise (e.g., from a fire-and-
   * forget touch record) should never bring the server down. The rejections
   * are still logged as errors for debugging.
   */
  process.on("unhandledRejection", (reason, promise) => {
    logProcessFault(eventSink, "unhandledRejection", reason, {
      promise: String(promise),
      action: "logged_continue",
    });
  });

  /**
   * Uncaught exceptions are fatal — the process must restart.
   *
   * `setImmediate` defers `process.exit(1)` by one tick. This lets
   * Node.js flush pending I/O (in-flight HTTP responses, DB queries)
   * before the process terminates, so clients get proper error codes
   * instead of connection resets.
   */
  process.on("uncaughtException", (error, origin) => {
    logProcessFault(eventSink, "uncaughtException", error, {
      origin,
      action: "flush_then_exit",
    });

    setImmediate(() => {
      process.exit(1);
    });
  });
}
