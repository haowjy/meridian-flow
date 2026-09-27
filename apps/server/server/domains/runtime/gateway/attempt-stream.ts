/**
 * Per-attempt stream driver: runs one provider adapter with retry/backoff and
 * per-attempt timeouts. Isolated from gateway composition (routing, fallback,
 * settlement) so the retry/deadline contract has one testable home.
 *
 * Timeout policy:
 * - Stall timeout aborts only when the stream makes no progress; every event
 *   re-arms it, so a slow-but-streaming model is never killed.
 * - Absolute ceiling bounds the pathological streaming-forever case.
 *
 * Retry gate: retry only before committed output (visible text or a tool call)
 * has reached the caller. Reasoning-only attempts are retryable, which is what
 * makes `maxAttempts` real for reasoning-first providers.
 */
import {
  createModelAttemptSignal,
  DEFAULT_ATTEMPT_CEILING_MS,
  DEFAULT_ATTEMPT_STALL_MS,
  getModelAttemptTimeout,
  type ModelAttemptTimeouts,
  modelAttemptTimeoutEvent,
} from "./deadline.js";
import type { GatewayConfig, GenerateRequest, ModelInfo, StreamEvent } from "./domain/index.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";
import {
  isCommittedOutputEvent,
  isFirstTokenEvent,
  isPartialOutputEvent,
} from "./stream-events.js";

/** Wall-clock bound for post-output cancel drain — providers that ignore abort must not hang forever. */
const CANCEL_DRAIN_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 1_048_576;

interface ArrivingEvent {
  event: StreamEvent;
  arrivedAt: number;
  estimatedBytes: number;
  arrivedBeforeBackpressure: boolean;
}

/**
 * Eagerly collected provider events are bounded so persistence lag cannot
 * retain an unbounded stream. One oversized event is allowed through an empty
 * buffer so a large provider chunk can always make progress.
 */
class EventBuffer {
  private readonly events: ArrivingEvent[] = [];
  private bytes = 0;
  private closed = false;
  private failure: unknown;
  private reader:
    | {
        resolve: (result: IteratorResult<ArrivingEvent>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private spaceAvailable: (() => void) | undefined;

  async push(event: ArrivingEvent, onBackpressure: () => void): Promise<boolean> {
    let waiting = false;
    while (
      !this.closed &&
      this.events.length > 0 &&
      this.bytes + event.estimatedBytes > MAX_BUFFERED_BYTES
    ) {
      if (!waiting) {
        waiting = true;
        onBackpressure();
      }
      await new Promise<void>((resolve) => {
        this.spaceAvailable = resolve;
      });
    }
    if (this.closed) return false;

    if (this.reader) {
      const reader = this.reader;
      this.reader = undefined;
      reader.resolve({ done: false, value: event });
    } else {
      this.events.push(event);
      this.bytes += event.estimatedBytes;
    }
    return true;
  }

  next(): Promise<IteratorResult<ArrivingEvent>> {
    const event = this.events.shift();
    if (event) {
      this.bytes -= event.estimatedBytes;
      this.spaceAvailable?.();
      this.spaceAvailable = undefined;
      return Promise.resolve({ done: false, value: event });
    }
    if (this.closed) {
      return this.failure === undefined
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.reader = { resolve, reject };
    });
  }

  finish(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.spaceAvailable?.();
    this.spaceAvailable = undefined;
    if (this.events.length === 0 && this.reader) {
      const reader = this.reader;
      this.reader = undefined;
      if (error === undefined) reader.resolve({ done: true, value: undefined });
      else reader.reject(error);
    }
  }
}

function estimatedEventBytes(event: StreamEvent): number {
  switch (event.type) {
    case "text.delta":
    case "reasoning.delta":
      return 64 + event.text.length * 2;
    case "tool_call.delta":
      return 64 + (event.id.length + event.name.length + event.argumentsDelta.length) * 2;
    case "custom.delta":
      return 64 + event.kind.length * 2 + estimatedUnknownBytes(event.data);
    case "start":
      return 64 + (event.provider.length + event.model.length) * 2;
    case "usage":
    case "error":
      return 128;
    case "end":
      return (
        256 +
        estimatedUnknownBytes(event.result.content) +
        estimatedUnknownBytes(event.result.toolCalls) +
        estimatedUnknownBytes(event.result.providerData)
      );
  }
}

function estimatedUnknownBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : serialized.length * 2;
  } catch {
    // An unmeasurable provider payload is treated as oversized and admitted
    // only when the queue is empty, rather than escaping the queue's budget.
    return MAX_BUFFERED_BYTES + 1;
  }
}

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/** Gateway-level timeout policy; a model's own overrides win over these. */
export interface ModelAttemptTimeoutOverrides {
  attemptStallMs?: number;
  attemptCeilingMs?: number;
}

/**
 * Resolve the effective timeouts for one model attempt: per-model override,
 * then gateway policy, then the process default.
 */
export function resolveModelAttemptTimeouts(
  model: Pick<ModelInfo, "stallTimeoutMs" | "ceilingTimeoutMs">,
  gateway: ModelAttemptTimeoutOverrides,
): ModelAttemptTimeouts {
  return {
    stallMs: model.stallTimeoutMs ?? gateway.attemptStallMs ?? DEFAULT_ATTEMPT_STALL_MS,
    ceilingMs: model.ceilingTimeoutMs ?? gateway.attemptCeilingMs ?? DEFAULT_ATTEMPT_CEILING_MS,
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason !== undefined
    ? signal.reason
    : new DOMException("Request aborted", "AbortError");
}

/** Abort-aware sleep used for exponential backoff between retry attempts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function* streamWithRetry(
  adapter: ProviderAdapter,
  request: GenerateRequest,
  model: ModelInfo,
  retry: GatewayConfig["retry"],
  timeouts: ModelAttemptTimeouts,
  options: { now?: () => number } = {},
): AsyncGenerator<StreamEvent> {
  const now = options.now ?? (() => performance.now());
  const maxAttempts = retry?.maxAttempts ?? 1;
  let delay = retry?.initialDelayMs ?? 500;
  const maxDelay = retry?.maxDelayMs ?? 10_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let sawError: StreamEvent | undefined;
    let emittedOutput = false;
    let emittedCommittedOutput = false;
    const attemptSignal = createModelAttemptSignal(request.signal, timeouts);
    const startedAt = now();
    const requestStartedAt = new Date().toISOString();
    const iterator = adapter
      .stream({ ...request, signal: attemptSignal.signal }, model)
      [Symbol.asyncIterator]();
    const buffer = new EventBuffer();
    let backpressured = false;
    let firstTokenAt: number | undefined;
    let firstTokenArrivedBeforeBackpressure = false;

    const pump = async () => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            buffer.finish();
            return;
          }
          if (!attemptSignal.signal.aborted) attemptSignal.notifyProgress();
          const event = next.value;
          const arrivedAt = now();
          const arrivedBeforeBackpressure = !backpressured;
          if (firstTokenAt === undefined && isFirstTokenEvent(event)) {
            firstTokenAt = arrivedAt;
            firstTokenArrivedBeforeBackpressure = arrivedBeforeBackpressure;
          }
          const accepted = await buffer.push(
            {
              event,
              arrivedAt,
              estimatedBytes: estimatedEventBytes(event),
              arrivedBeforeBackpressure,
            },
            () => {
              backpressured = true;
            },
          );
          if (!accepted) return;
        }
      } catch (error) {
        buffer.finish(error);
      }
    };
    void pump();

    // One subscription and one absolute cancel deadline for the entire attempt,
    // including any usage drain after an adapter rejection.
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    type Stop = { kind: "stop"; error?: unknown };
    let stop!: (result: Stop) => void;
    const stopped = new Promise<Stop>((resolve) => {
      stop = resolve;
    });
    const onAbort = () => {
      const timeout = getModelAttemptTimeout(attemptSignal.signal);
      if (timeout || !emittedOutput) {
        stop({ kind: "stop", error: timeout ?? abortReason(attemptSignal.signal) });
      } else {
        cancelTimer = setTimeout(() => stop({ kind: "stop" }), CANCEL_DRAIN_TIMEOUT_MS);
      }
    };
    attemptSignal.signal.addEventListener("abort", onAbort, { once: true });
    if (attemptSignal.signal.aborted) onAbort();
    const read = async (): Promise<IteratorResult<ArrivingEvent>> => {
      const next = await Promise.race([
        stopped,
        buffer.next().then((result) => ({ kind: "next" as const, result })),
      ]);
      if (next.kind === "next") return next.result;
      if (next.error !== undefined) throw next.error;
      return { done: true, value: undefined };
    };
    const timeTerminalEvent = (arrival: ArrivingEvent): StreamEvent => {
      if (arrival.event.type !== "end") return arrival.event;
      return {
        ...arrival.event,
        result: {
          ...arrival.event.result,
          timing: {
            requestStartedAt,
            latencyMs: arrival.arrivedBeforeBackpressure
              ? elapsedMs(startedAt, arrival.arrivedAt)
              : null,
            timeToFirstTokenMs:
              firstTokenAt === undefined || !firstTokenArrivedBeforeBackpressure
                ? null
                : elapsedMs(startedAt, firstTokenAt),
            generationMs:
              firstTokenAt === undefined || backpressured
                ? null
                : elapsedMs(firstTokenAt, arrival.arrivedAt),
          },
        },
      };
    };
    try {
      while (true) {
        const next = await read();
        if (next.done) break;
        if (!attemptSignal.signal.aborted) attemptSignal.notifyProgress();
        const { event } = next.value;
        if (event.type === "error") {
          // If the attempt was killed by a timer, surface that timeout event
          // (retryable) instead of whatever the SDK emitted.
          sawError = modelAttemptTimeoutEvent(attemptSignal.signal) ?? event;
          if (emittedCommittedOutput || !sawError.retryable || attempt >= maxAttempts) {
            yield sawError;
            return;
          }
          break;
        }
        emittedOutput ||= isPartialOutputEvent(event);
        emittedCommittedOutput ||= isCommittedOutputEvent(event);
        if (event.type === "end") {
          yield timeTerminalEvent(next.value);
          return;
        }
        yield event;
      }
    } catch (error) {
      const timeoutEvent = modelAttemptTimeoutEvent(attemptSignal.signal);
      if (timeoutEvent) {
        sawError = timeoutEvent;
      } else if (emittedOutput && request.signal?.aborted) {
        // Some adapters reject the interrupted read before emitting final usage.
        // Continue on the same reader; the original cancel deadline still wins.
        try {
          while (true) {
            const next = await read();
            if (next.done) return;
            const { event } = next.value;
            const terminalEvent = timeTerminalEvent(next.value);
            yield terminalEvent;
            if (event.type === "end" || event.type === "error") return;
          }
        } catch {
          // Cancellation also permits the adapter to close by rejecting.
          return;
        }
      } else {
        sawError = {
          type: "error",
          code: request.signal?.aborted ? "invalid_request" : "provider_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        };
      }
      if (emittedCommittedOutput || !sawError.retryable || attempt >= maxAttempts) {
        yield sawError;
        return;
      }
    } finally {
      buffer.finish();
      attemptSignal.signal.removeEventListener("abort", onAbort);
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      attemptSignal.cleanup();
      // A stuck next() can prevent return() from ever settling. Observe teardown
      // rejection without letting provider cleanup hold the run or retry hostage.
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
    }

    if (sawError?.type === "error") {
      if (sawError.retryable && attempt < maxAttempts) {
        // Exponential backoff: wait before retrying, respecting parent abort.
        await sleep(Math.min(Math.max(delay, sawError.retryAfterMs ?? 0), 60_000), request.signal);
        delay = Math.min(delay * 2, maxDelay);
        continue;
      }
      yield sawError;
      return;
    }
    return;
  }
}
