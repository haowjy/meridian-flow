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
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldDrainUserCancel(
  request: GenerateRequest,
  attemptSignal: AbortSignal,
  emittedOutput: boolean,
): boolean {
  return Boolean(
    emittedOutput && request.signal?.aborted && getModelAttemptTimeout(attemptSignal) === null,
  );
}

async function drainCancelledAdapterEvents(
  iterator: AsyncIterator<StreamEvent>,
  deadlineMs = CANCEL_DRAIN_TIMEOUT_MS,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const deadline = Date.now() + deadlineMs;
  let timedOut = false;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const raced = await Promise.race([
        iterator.next().then((result) => ({ kind: "next" as const, result })),
        sleep(remaining).then(() => ({ kind: "timeout" as const })),
      ]);

      if (raced.kind === "timeout") {
        timedOut = true;
        break;
      }

      const drained = raced.result;
      if (drained.done) break;
      events.push(drained.value);
      if (drained.value.type === "end" || drained.value.type === "error") break;
    }
  } catch {
    // Adapter already closed.
  }

  if (timedOut) {
    await iterator.return?.().catch(() => undefined);
  }

  return events;
}

async function* yieldDrainedCancelEvents(
  iterator: AsyncIterator<StreamEvent>,
): AsyncGenerator<StreamEvent, StreamEvent | undefined> {
  for (const event of await drainCancelledAdapterEvents(iterator)) {
    yield event;
    if (event.type === "end" || event.type === "error") {
      return event;
    }
  }
  return undefined;
}

type InFlightNextResult =
  | { kind: "next"; result: IteratorResult<StreamEvent> }
  | { kind: "drain_budget_exhausted" };

/**
 * Read the next adapter event. Parent cancel after partial output races the
 * in-flight iterator.next() against a drain deadline so providers that ignore
 * abort cannot hang forever. Attempt timeouts still hard-interrupt via a narrow
 * race that only rejects on ModelAttemptTimeoutError.
 */
async function boundedInFlightNext(
  waitForNext: Promise<IteratorResult<StreamEvent>>,
  iterator: AsyncIterator<StreamEvent>,
  deadlineMs = CANCEL_DRAIN_TIMEOUT_MS,
): Promise<InFlightNextResult> {
  const raced = await Promise.race([
    waitForNext.then((result) => ({ kind: "next" as const, result })),
    sleep(deadlineMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (raced.kind === "timeout") {
    await iterator.return?.().catch(() => undefined);
    return { kind: "drain_budget_exhausted" };
  }
  return { kind: "next", result: raced.result };
}

function attemptTimeoutRace(attemptSignal: AbortSignal): Promise<IteratorResult<StreamEvent>> {
  return new Promise<IteratorResult<StreamEvent>>((_, reject) => {
    const onAttemptAbort = () => {
      const timeout = getModelAttemptTimeout(attemptSignal);
      if (timeout) reject(timeout);
    };
    if (attemptSignal.aborted) onAttemptAbort();
    else attemptSignal.addEventListener("abort", onAttemptAbort, { once: true });
  });
}

type NextStreamEventResult =
  | { kind: "next"; result: IteratorResult<StreamEvent> }
  | { kind: "drain_budget_exhausted" };

async function nextStreamEvent(
  iterator: AsyncIterator<StreamEvent>,
  attemptSignal: AbortSignal,
  parentSignal: AbortSignal | undefined,
  emittedOutput: boolean,
): Promise<NextStreamEventResult> {
  if (parentSignal?.aborted && !emittedOutput) {
    throw parentSignal.reason ?? new Error("Request aborted");
  }

  const waitForNext = iterator.next();

  if (emittedOutput && parentSignal) {
    if (parentSignal.aborted) {
      return boundedInFlightNext(waitForNext, iterator);
    }

    return await Promise.race([
      waitForNext.then((result) => ({ kind: "next" as const, result })),
      attemptTimeoutRace(attemptSignal).then((result) => ({ kind: "next" as const, result })),
      new Promise<NextStreamEventResult>((resolve) => {
        parentSignal.addEventListener(
          "abort",
          () => {
            void boundedInFlightNext(waitForNext, iterator).then(resolve);
          },
          { once: true },
        );
      }),
    ]);
  }

  const result = await Promise.race([waitForNext, attemptTimeoutRace(attemptSignal)]);
  return { kind: "next", result };
}

/**
 * Stream with exponential-backoff retry for a single provider.
 *
 * Lifecycle per attempt:
 * 1. Create a derived AbortSignal (createModelAttemptSignal) that combines the
 *    parent request.signal with the stall and ceiling timers.
 * 2. Start the adapter stream and iterate events via nextStreamEvent, re-arming
 *    the stall timer on every event.
 * 3. If an `error` event arrives before any committed output, and it's
 *    retryable, and attempts remain: break the inner loop, sleep with backoff,
 *    retry.
 * 4. If an error arrives after committed output, or it's non-retryable, or
 *    attempts are exhausted: yield the error and return immediately — no retry.
 * 5. If the iterator throws (network error, SDK exception): wrap as error
 *    event and apply the same retry logic.
 * 6. In the finally block: call iterator.return() to release provider
 *    resources, then cleanup() to clear the timers.
 *
 * `emittedOutput` gates cancel draining (any partial content, reasoning
 * included). `emittedCommittedOutput` gates retry (visible text or tool call
 * only), so a reasoning-only abort is retryable.
 */
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
    try {
      while (true) {
        const nextResult = await nextStreamEvent(
          iterator,
          attemptSignal.signal,
          request.signal,
          emittedOutput,
        );
        if (nextResult.kind === "drain_budget_exhausted") {
          break;
        }
        const next = nextResult.result;
        if (next.done) {
          if (shouldDrainUserCancel(request, attemptSignal.signal, emittedOutput)) {
            const terminal = yield* yieldDrainedCancelEvents(iterator);
            if (terminal?.type === "end") return;
            if (terminal?.type === "error") return;
          }
          break;
        }
        attemptSignal.notifyProgress();
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
        yield event;
        emittedOutput ||= isPartialOutputEvent(event);
        emittedCommittedOutput ||= isCommittedOutputEvent(event);
        if (event.type === "end") return;
      }
    } catch (error) {
      const timeoutEvent = modelAttemptTimeoutEvent(attemptSignal.signal);
      if (timeoutEvent) {
        sawError = timeoutEvent;
      } else if (emittedOutput && request.signal?.aborted) {
        const terminal = yield* yieldDrainedCancelEvents(iterator);
        if (terminal?.type === "end") return;
        if (terminal?.type === "error") {
          sawError = terminal;
        } else {
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
      // Release provider stream resources and clear the timers.
      // iterator.return() may fail if the stream is already closed — that's fine.
      await iterator.return?.().catch(() => undefined);
      attemptSignal.cleanup();
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
