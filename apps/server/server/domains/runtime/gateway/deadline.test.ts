/** Unit coverage for the stall/ceiling attempt signal: arming, re-arming, disabling, classification. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelAttemptSignal,
  getModelAttemptTimeout,
  modelAttemptTimeoutEvent,
} from "./deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createModelAttemptSignal", () => {
  it("aborts a stalled attempt after the stall window", () => {
    vi.useFakeTimers();
    const attempt = createModelAttemptSignal(undefined, { stallMs: 1_000, ceilingMs: 0 });

    vi.advanceTimersByTime(999);
    expect(attempt.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(getModelAttemptTimeout(attempt.signal)?.kind).toBe("stall");
    attempt.cleanup();
  });

  it("fires the ceiling even while the stream keeps making progress", () => {
    vi.useFakeTimers();
    const attempt = createModelAttemptSignal(undefined, { stallMs: 1_000, ceilingMs: 3_000 });

    for (let elapsed = 0; elapsed < 5_000; elapsed += 400) {
      vi.advanceTimersByTime(400);
      attempt.notifyProgress();
    }

    expect(getModelAttemptTimeout(attempt.signal)?.kind).toBe("ceiling");
    attempt.cleanup();
  });

  it("clears timers on cleanup before either window elapses", () => {
    vi.useFakeTimers();
    const attempt = createModelAttemptSignal(undefined, { stallMs: 500, ceilingMs: 1_000 });

    attempt.cleanup();
    vi.advanceTimersByTime(5_000);

    expect(attempt.signal.aborted).toBe(false);
  });

  it("propagates a parent abort without classifying it as a timeout", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const attempt = createModelAttemptSignal(parent.signal, { stallMs: 1_000, ceilingMs: 1_000 });

    parent.abort(new Error("writer cancelled"));

    expect(attempt.signal.aborted).toBe(true);
    expect(getModelAttemptTimeout(attempt.signal)).toBeNull();
    expect(modelAttemptTimeoutEvent(attempt.signal)).toBeNull();
    attempt.cleanup();
  });
});
