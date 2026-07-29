/**
 * Approach chrome's timing policy: believe a pointer that means it, ignore one
 * crossing the page, and stay long enough for the writer to reach what appeared.
 *
 * Headless and hand-cranked, because a test that waits 100ms to learn the delay
 * is 100ms of a test suite and no more certain than this.
 */

import { describe, expect, it, vi } from "vitest";

import { CHROME_TIMING, createHoverIntent, type HoverIntentTimers } from "./hover-intent";

/** A hand-cranked clock, so the timing policy is asserted rather than waited on. */
function fakeTimers() {
  const queued = new Map<number, { run: () => void; at: number }>();
  let handle = 0;
  let now = 0;

  const timers: HoverIntentTimers = {
    setTimeout(run, ms) {
      handle += 1;
      queued.set(handle, { run, at: now + ms });
      return handle;
    },
    clearTimeout(id) {
      queued.delete(id);
    },
  };

  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...queued]) {
        if (entry.at > now) continue;
        queued.delete(id);
        entry.run();
      }
    },
  };
}

describe("hover intent", () => {
  it("ignores a pointer crossing the page and answers one that rests", () => {
    const { timers, advance } = fakeTimers();
    const settled = vi.fn();
    const intent = createHoverIntent({ onSettle: settled, timers });

    intent.enter("figure");
    advance(CHROME_TIMING.handleIntentMs - 1);
    intent.leave();
    advance(1_000);
    expect(settled).not.toHaveBeenCalled();

    intent.enter("figure");
    advance(CHROME_TIMING.handleIntentMs);
    expect(settled).toHaveBeenCalledExactlyOnceWith("figure");
  });

  it("answers the next object immediately once something is already revealed", () => {
    const { timers, advance } = fakeTimers();
    const settled = vi.fn();
    const intent = createHoverIntent({ onSettle: settled, timers });

    intent.enter("first");
    advance(CHROME_TIMING.handleIntentMs);
    intent.enter("second");

    expect(settled).toHaveBeenLastCalledWith("second");
  });

  it("holds the row through the grace so the pointer can cross onto it", () => {
    const { timers, advance } = fakeTimers();
    const settled = vi.fn();
    const intent = createHoverIntent({ onSettle: settled, timers });

    intent.enter("figure");
    advance(CHROME_TIMING.handleIntentMs);
    settled.mockClear();

    intent.leave();
    advance(CHROME_TIMING.fadeMs - 1);
    intent.enter("figure");
    advance(1_000);

    expect(settled).not.toHaveBeenCalled();
    expect(intent.settled).toBe("figure");
  });
});
