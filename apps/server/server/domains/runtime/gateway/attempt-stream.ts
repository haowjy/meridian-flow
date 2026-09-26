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
import { isCommittedOutputEvent, isPartialOutputEvent } from "./stream-events.js";

/** Wall-clock bound for post-output cancel drain — providers that ignore abort must not hang forever. */
const CANCEL_DRAIN_TIMEOUT_MS = 5_000;

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
): AsyncGenerator<StreamEvent> {
  const maxAttempts = retry?.maxAttempts ?? 1;
  let delay = retry?.initialDelayMs ?? 500;
  const maxDelay = retry?.maxDelayMs ?? 10_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let sawError: StreamEvent | undefined;
    let emittedOutput = false;
    let emittedCommittedOutput = false;
    const attemptSignal = createModelAttemptSignal(request.signal, timeouts);
    const iterator = adapter
      .stream({ ...request, signal: attemptSignal.signal }, model)
      [Symbol.asyncIterator]();
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
    const read = async (): Promise<IteratorResult<StreamEvent>> => {
      const next = await Promise.race([
        stopped,
        iterator.next().then((result) => ({ kind: "next" as const, result })),
      ]);
      if (next.kind === "next") return next.result;
      if (next.error !== undefined) throw next.error;
      return { done: true, value: undefined };
    };
    try {
      while (true) {
        const next = await read();
        if (next.done) break;
        if (!attemptSignal.signal.aborted) attemptSignal.notifyProgress();
        const event = next.value;
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
        yield event;
        if (event.type === "end") return;
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
            yield next.value;
            if (next.value.type === "end" || next.value.type === "error") return;
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
        await sleep(delay, request.signal);
        delay = Math.min(delay * 2, maxDelay);
        continue;
      }
      yield sawError;
      return;
    }
    return;
  }
}
