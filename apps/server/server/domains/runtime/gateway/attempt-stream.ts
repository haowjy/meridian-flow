/**
 * Per-attempt stream driver: runs one provider adapter with retry/backoff and
 * per-attempt timeouts. Isolated from gateway composition (routing,
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
import {
  type GatewayConfig,
  type GenerateRequest,
  type ModelInfo,
  resolveCall,
  type StreamEvent,
} from "./domain/index.js";
import { hasBillableTokenUsage, withMissingUsageMetering } from "./domain/metering.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";
import { isCommittedOutputEvent, isFirstTokenEvent } from "./stream-events.js";

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
    case "start":
      return 64 + (event.provider.length + event.model.length) * 2;
    case "usage":
      return 128;
    case "error":
      return 128 + estimatedUnknownBytes(event.result);
    case "end":
      return (
        256 +
        estimatedUnknownBytes(event.result.content) +
        estimatedUnknownBytes(event.result.toolCalls)
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

/** Gateway-level timeout policy. */
export interface ModelAttemptTimeoutOverrides {
  attemptStallMs?: number;
  attemptCeilingMs?: number;
}

/** The effective timeouts for an attempt: gateway policy, then the process default. */
export function resolveAttemptTimeouts(
  gateway: ModelAttemptTimeoutOverrides,
): ModelAttemptTimeouts {
  return {
    stallMs: gateway.attemptStallMs ?? DEFAULT_ATTEMPT_STALL_MS,
    ceilingMs: gateway.attemptCeilingMs ?? DEFAULT_ATTEMPT_CEILING_MS,
  };
}

/** Abort-aware sleep for backoff between retry attempts: resolves early on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
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
  const call = resolveCall(request, model);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A stop that landed before this attempt started made no call, so it leaves no response.
    if (request.signal?.aborted) return;
    let sawError: StreamEvent | undefined;
    let emittedCommittedOutput = false;
    const attemptSignal = createModelAttemptSignal(request.signal, timeouts);
    const startedAt = now();
    const requestStartedAt = new Date().toISOString();
    const iterator = adapter
      .stream({ ...request, signal: attemptSignal.signal }, model, call)
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
          // The provider has finished: a timer firing now would discard a complete result.
          if ((event.type === "end" || event.type === "error") && !attemptSignal.signal.aborted) {
            attemptSignal.cleanup();
          }
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

    // A timeout ends the attempt at once with its error; a caller's stop ends in the adapter's `end`.
    let timedOut!: (error: unknown) => void;
    const stopped = new Promise<{ kind: "timeout"; error: unknown }>((resolve) => {
      timedOut = (error) => resolve({ kind: "timeout", error });
    });
    const onAbort = () => {
      const timeout = getModelAttemptTimeout(attemptSignal.signal);
      if (timeout) timedOut(timeout);
    };
    attemptSignal.signal.addEventListener("abort", onAbort, { once: true });
    const read = async (): Promise<IteratorResult<ArrivingEvent>> => {
      const next = await Promise.race([stopped, buffer.next()]);
      if ("kind" in next) throw next.error;
      return next;
    };
    const timeTerminalEvent = (arrival: ArrivingEvent): StreamEvent => {
      if (arrival.event.type !== "end" && arrival.event.type !== "error") return arrival.event;
      const terminal = arrival.event.result;
      if (!terminal) return arrival.event;
      // A stopped call's finish reason is the adapter's default, not what happened. A stop can
      // also land before the provider's usage arrives (OpenAI-compatible sends it in the final
      // chunk). Mark both here so every adapter's partial result is settled and persisted.
      let result = terminal;
      if (arrival.event.type === "end" && request.signal?.aborted) {
        result = { ...terminal, finishReason: null };
        if (!hasBillableTokenUsage(terminal.usage)) result = withMissingUsageMetering(result);
      }
      return {
        ...arrival.event,
        result: {
          ...result,
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
        // If the attempt was killed by a timer, surface that timeout event
        // (retryable) instead of whatever the SDK emitted.
        const failure =
          event.type === "error"
            ? (modelAttemptTimeoutEvent(attemptSignal.signal) ?? event)
            : undefined;
        if (failure) {
          sawError = failure;
          if (emittedCommittedOutput || !sawError.retryable || attempt >= maxAttempts) {
            yield timeTerminalEvent({ ...next.value, event: sawError });
            return;
          }
          break;
        }
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
      } else {
        sawError = {
          type: "error",
          code: "provider_error",
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
      // Aborting first releases an SDK stream hung on a pending next(), which return() would queue behind.
      attemptSignal.abort();
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
