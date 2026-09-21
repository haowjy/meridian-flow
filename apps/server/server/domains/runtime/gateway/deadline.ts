/**
 * Per-attempt model-call timeout: defines ModelAttemptTimeoutError and the
 * AbortSignal helper that surfaces a stall or ceiling timeout as a stream event.
 * Owns the single timeout convention shared by all provider adapters.
 *
 * Design: the gateway guards each attempt with two timers on one derived
 * AbortSignal, not a Promise.race on the full generator:
 * - The inactivity (stall) timer is the primary guard. It is re-armed on every
 *   stream progress event, so a slow-but-streaming model is never killed — only
 *   a stream that stops making progress is.
 * - The absolute ceiling is a backstop for a stream that never terminates. It is
 *   fixed from attempt start and is not the normal terminator; 0 disables it for
 *   self-hosted models.
 * - Either timer aborts the underlying provider HTTP stream (via the SDK's own
 *   signal support), not just the iterator.
 * - If the provider SDK ignores the signal, nextStreamEvent in attempt-stream
 *   races the iterator against the abort anyway.
 * - The timeout error is surfaced as a retryable `provider_error` StreamEvent,
 *   so the retry/fallback machinery can try the same provider again or fail
 *   over to the next fallback.
 */
const ATTEMPT_TIMEOUT_NAME = "ModelAttemptTimeoutError";

/** Default inactivity window before an attempt with no stream progress is aborted. */
export const DEFAULT_ATTEMPT_STALL_MS = 120_000;
/** Default absolute ceiling for one attempt. 0 disables it (e.g. self-hosted models). */
export const DEFAULT_ATTEMPT_CEILING_MS = 600_000;

export type ModelAttemptTimeoutKind = "stall" | "ceiling";

export interface ModelAttemptTimeouts {
  /** Abort after this long with no stream progress. 0 disables the stall guard. */
  stallMs: number;
  /** Absolute per-attempt ceiling. 0 disables the ceiling backstop. */
  ceilingMs: number;
}

export class ModelAttemptTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly kind: ModelAttemptTimeoutKind,
  ) {
    super(
      kind === "stall"
        ? `Model stream stalled for ${timeoutMs}ms`
        : `Model request exceeded its ${timeoutMs}ms ceiling`,
    );
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

export interface ModelAttemptSignal {
  signal: AbortSignal;
  /** Re-arm the inactivity deadline. Call on every stream progress event. */
  notifyProgress: () => void;
  /** Clear both timers and the parent listener. Idempotent. */
  cleanup: () => void;
}

/**
 * Create a derived AbortSignal that combines a parent signal with a resettable
 * inactivity timer and a fixed ceiling timer.
 *
 * Behavior:
 * - If the parent is already aborted: returns the parent signal with no-op
 *   notifyProgress/cleanup (no timer to clear).
 * - Otherwise creates an AbortController armed with both timers. `notifyProgress`
 *   resets only the stall timer; the ceiling timer is never extended.
 * - A timer value <= 0 disables that timer. With both disabled the attempt has no
 *   deadline at all (explicit self-hosted configuration).
 * - If the parent aborts first, clears both timers and propagates the parent's
 *   abort reason.
 * - cleanup() is idempotent and safe to call multiple times.
 */
export function createModelAttemptSignal(
  parent: AbortSignal | undefined,
  timeouts: ModelAttemptTimeouts,
): ModelAttemptSignal {
  if (parent?.aborted) {
    return { signal: parent, notifyProgress: () => {}, cleanup: () => {} };
  }

  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;

  const armStall = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer =
      timeouts.stallMs > 0
        ? setTimeout(() => {
            controller.abort(new ModelAttemptTimeoutError(timeouts.stallMs, "stall"));
          }, timeouts.stallMs)
        : undefined;
  };

  armStall();
  if (timeouts.ceilingMs > 0) {
    ceilingTimer = setTimeout(() => {
      controller.abort(new ModelAttemptTimeoutError(timeouts.ceilingMs, "ceiling"));
    }, timeouts.ceilingMs);
  }

  const onParentAbort = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
    controller.abort(parent?.reason ?? new Error("Request aborted"));
  };
  parent?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    notifyProgress: armStall,
    cleanup: () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
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
