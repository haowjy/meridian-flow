/**
 * Unit tests for the debounced document subscription helper.
 *
 * Hook-level transport wiring invariants are covered separately in
 * `useDocumentCollabTransport.test.ts`.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { createDocumentSubscriptionDebounce } from "@/features/documents/hooks/documentSubscriptionDebounce";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Debounce helper tests
// ---------------------------------------------------------------------------

describe("documentSubscriptionDebounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls unsubscribe after debounce delay", () => {
    const unsubscribe = vi.fn();
    const debounce = createDocumentSubscriptionDebounce({ debounceMs: 100 });

    debounce.scheduleUnsubscribe(DOC_A, unsubscribe);

    expect(unsubscribe).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    debounce.destroy();
  });

  it("cancels pending unsubscribe when subscribe is called before timer fires", () => {
    const unsubscribe = vi.fn();
    const debounce = createDocumentSubscriptionDebounce({ debounceMs: 100 });

    debounce.scheduleUnsubscribe(DOC_A, unsubscribe);

    // Re-subscribe before debounce fires (simulates StrictMode remount)
    vi.advanceTimersByTime(50);
    debounce.subscribe(DOC_A);

    // Even after waiting well past the debounce period, unsubscribe should not fire
    vi.advanceTimersByTime(200);

    expect(unsubscribe).not.toHaveBeenCalled();

    debounce.destroy();
  });

  it("handles multiple documents independently", () => {
    const unsubA = vi.fn();
    const unsubB = vi.fn();
    const debounce = createDocumentSubscriptionDebounce({ debounceMs: 100 });

    debounce.scheduleUnsubscribe(DOC_A, unsubA);
    debounce.scheduleUnsubscribe(DOC_B, unsubB);

    // Cancel only DOC_A
    debounce.subscribe(DOC_A);

    vi.advanceTimersByTime(100);

    expect(unsubA).not.toHaveBeenCalled();
    expect(unsubB).toHaveBeenCalledTimes(1);

    debounce.destroy();
  });

  it("replaces pending unsubscribe on second scheduleUnsubscribe call", () => {
    const firstUnsub = vi.fn();
    const secondUnsub = vi.fn();
    const debounce = createDocumentSubscriptionDebounce({ debounceMs: 100 });

    debounce.scheduleUnsubscribe(DOC_A, firstUnsub);
    debounce.scheduleUnsubscribe(DOC_A, secondUnsub);

    vi.advanceTimersByTime(100);

    expect(firstUnsub).not.toHaveBeenCalled();
    expect(secondUnsub).toHaveBeenCalledTimes(1);

    debounce.destroy();
  });

  it("destroy cancels all pending timers", () => {
    const unsubA = vi.fn();
    const unsubB = vi.fn();
    const debounce = createDocumentSubscriptionDebounce({ debounceMs: 100 });

    debounce.scheduleUnsubscribe(DOC_A, unsubA);
    debounce.scheduleUnsubscribe(DOC_B, unsubB);

    debounce.destroy();

    vi.advanceTimersByTime(200);

    expect(unsubA).not.toHaveBeenCalled();
    expect(unsubB).not.toHaveBeenCalled();
  });

  it("uses custom timer functions when provided", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const setTimer = vi.fn((cb: () => void, ms: number) => 42);
    const clearTimer = vi.fn();

    const debounce = createDocumentSubscriptionDebounce({
      debounceMs: 100,
      setTimer,
      clearTimer,
    });

    const unsubscribe = vi.fn();
    debounce.scheduleUnsubscribe(DOC_A, unsubscribe);

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 100);

    debounce.subscribe(DOC_A);

    expect(clearTimer).toHaveBeenCalledWith(42);

    debounce.destroy();
  });
});
