/** Unit coverage for the stall/ceiling attempt signal: arming, re-arming, disabling, classification. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelAttemptSignal,
  getModelAttemptTimeout,
  ModelAttemptTimeoutError,
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

  it("never fires the stall while progress keeps re-arming it", () => {
    vi.useFakeTimers();
    const attempt = createModelAttemptSignal(undefined, { stallMs: 1_000, ceilingMs: 0 });

    for (let elapsed = 0; elapsed < 5_000; elapsed += 400) {
      vi.advanceTimersByTime(400);
      attempt.notifyProgress();
      expect(attempt.signal.aborted).toBe(false);
    }

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

  it("disables a zero stall or ceiling window", () => {
    vi.useFakeTimers();
    const attempt = createModelAttemptSignal(undefined, { stallMs: 0, ceilingMs: 0 });

    attempt.notifyProgress();
    vi.advanceTimersByTime(60 * 60 * 1_000);

    expect(attempt.signal.aborted).toBe(false);
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

  it("classifies a stall as a retryable provider_error", () => {
    vi.useFakeTimers();
    const attempt = createModelAttemptSignal(undefined, { stallMs: 250, ceilingMs: 0 });

    vi.advanceTimersByTime(250);

    expect(modelAttemptTimeoutEvent(attempt.signal)).toEqual({
      type: "error",
      code: "provider_error",
      message: "Model stream stalled for 250ms",
      retryable: true,
    });
    expect(new ModelAttemptTimeoutError(250, "stall").message).toContain("stalled");
    attempt.cleanup();
  });
});
