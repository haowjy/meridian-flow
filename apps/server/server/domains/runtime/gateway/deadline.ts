/**
 * Per-attempt model-call timeout: defines ModelAttemptTimeoutError and the
 * AbortSignal helpers that surface a timeout as a stream event. Owns the
 * single timeout convention shared by all provider adapters.
 *
 * Design: the gateway enforces per-attempt timeouts via AbortSignal derivation,
 * not via Promise.race on the full generator. This means:
 * - The timeout aborts the underlying provider HTTP stream (via the SDK's own
 *   signal support), not just the iterator.
 * - If the provider SDK ignores the signal, nextStreamEvent in create-gateway
 *   races the iterator against the abort anyway.
 * - The timeout error is surfaced as a retryable `provider_error` StreamEvent,
 *   so the retry/fallback machinery can try the same provider again or fail
 *   over to the next fallback.
 */
const ATTEMPT_TIMEOUT_NAME = "ModelAttemptTimeoutError";

export class ModelAttemptTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Model request timed out after ${timeoutMs}ms`);
    this.name = ATTEMPT_TIMEOUT_NAME;
  }
}

/**
 * Inspect an AbortSignal's reason to see if it was caused by a model attempt
 * timeout. Returns the ModelAttemptTimeoutError instance if so, null otherwise.
 */
export function getModelAttemptTimeout(
  signal: AbortSignal | undefined,
): ModelAttemptTimeoutError | null {
  const reason = signal?.reason;
  return reason instanceof ModelAttemptTimeoutError ? reason : null;
}

/**
 * Create a derived AbortSignal that combines a parent signal with a wall-clock
 * timeout. Returns both the derived signal and a cleanup function.
 *
 * Behavior:
 * - If the parent is already aborted: returns the parent signal directly with
 *   a no-op cleanup (no timer to clear).
 * - Otherwise: creates an AbortController with a setTimeout that fires after
 *   `timeoutMs`. If the parent aborts before the timeout, clears the timer and
 *   propagates the parent's abort reason.
 * - The cleanup function clears the timer and removes the parent listener.
 *   It is idempotent and safe to call multiple times.
 */
export function createModelAttemptSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  if (parent?.aborted) {
    return { signal: parent, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new ModelAttemptTimeoutError(timeoutMs));
  }, timeoutMs);

  const onParentAbort = () => {
    clearTimeout(timeout);
    controller.abort(parent?.reason ?? new Error("Request aborted"));
  };
  parent?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Check whether an abort signal was triggered by a model attempt timeout.
 * Returns a canonical retryable error event if so, null otherwise.
 * This is called in streamWithRetry to classify abort reasons: timeouts are
 * retryable, user-initiated cancellations (parent signal abort) are not.
 */
export function modelAttemptTimeoutEvent(signal: AbortSignal | undefined): {
  type: "error";
  code: "provider_error";
  message: string;
  retryable: true;
} | null {
  const timeout = getModelAttemptTimeout(signal);
  if (!timeout) return null;
  return {
    type: "error",
    code: "provider_error",
    message: timeout.message,
    retryable: true,
  };
}
