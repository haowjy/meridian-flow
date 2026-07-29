/**
 * Hover intent and the chrome timings, in one place.
 *
 * Approach chrome (law 7) has to answer a writer who means it and ignore a
 * pointer crossing the page on its way somewhere else. That is a delay on the
 * way in, a grace on the way out so the pointer can travel from an object to
 * the row floating over it, and an immediate answer once the writer is already
 * being served — a menu bar that re-charges its delay for every neighbour
 * feels broken.
 *
 * Headless: the caller supplies the timers, so the policy is testable without
 * a DOM and a test can drive it without waiting.
 */

export const CHROME_TIMING = {
  /** Block handle appears in the margin on approach (§5.8). */
  handleIntentMs: 100,
  /** Object rows and table grips fade in and out (§5.2, §5.4, Q6). */
  fadeMs: 120,
} as const;

export type HoverIntentTimers = {
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
};

const WINDOW_TIMERS: HoverIntentTimers = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export type HoverIntentOptions<T> = {
  /** Delay before a cold pointer is believed. */
  enterMs?: number;
  /** Grace after leaving, so the pointer can cross onto what it revealed. */
  leaveMs?: number;
  /** The settled target, or null once nothing is hovered. */
  onSettle: (target: T | null) => void;
  timers?: HoverIntentTimers;
};

export type HoverIntent<T> = {
  /** The pointer is over `target`. */
  enter: (target: T) => void;
  /** The pointer left; the grace starts. */
  leave: () => void;
  /**
   * Drop everything now, settled or pending, without a grace period. The
   * kernel calls this when a gesture starts: approach chrome has no business
   * on screen while the writer is dragging or sweeping.
   */
  cancel: () => void;
  readonly settled: T | null;
  dispose: () => void;
};

export function createHoverIntent<T>({
  enterMs = CHROME_TIMING.handleIntentMs,
  leaveMs = CHROME_TIMING.fadeMs,
  onSettle,
  timers = WINDOW_TIMERS,
}: HoverIntentOptions<T>): HoverIntent<T> {
  let settled: T | null = null;
  let pending: number | null = null;

  const clearPending = () => {
    if (pending === null) return;
    timers.clearTimeout(pending);
    pending = null;
  };

  const settle = (target: T | null) => {
    pending = null;
    if (settled === target) return;
    settled = target;
    onSettle(target);
  };

  return {
    enter(target) {
      clearPending();
      // Warm: something is already revealed, so the writer is being served and
      // the next thing under the pointer answers without re-earning the delay.
      if (settled !== null) {
        settle(target);
        return;
      }
      pending = timers.setTimeout(() => settle(target), enterMs);
    },
    leave() {
      clearPending();
      if (settled === null) return;
      pending = timers.setTimeout(() => settle(null), leaveMs);
    },
    cancel() {
      clearPending();
      settle(null);
    },
    get settled() {
      return settled;
    },
    dispose() {
      clearPending();
      settled = null;
    },
  };
}
