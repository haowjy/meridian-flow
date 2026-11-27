import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";

const PROCESS_CRASH_POLICY_KEY = Symbol.for("meridian.api.process-crash-policy.v1");

type ProcessCrashPolicyGlobal = typeof globalThis & {
  [PROCESS_CRASH_POLICY_KEY]?: true;
};

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
      nodeEnv: process.env.NODE_ENV,
      ...unknownToEventPayload(reason),
      ...context,
    },
  });
}

export function installApiProcessCrashPolicy(options: { eventSink: EventSink }): void {
  const eventSink = options.eventSink;
  const store = globalThis as ProcessCrashPolicyGlobal;
  if (store[PROCESS_CRASH_POLICY_KEY]) return;
  store[PROCESS_CRASH_POLICY_KEY] = true;

  process.on("unhandledRejection", (reason) => {
    logProcessFault(eventSink, "unhandledRejection", reason, {
      action: "logged_continue",
    });
  });

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
