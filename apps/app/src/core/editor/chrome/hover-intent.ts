export const CHROME_TIMING = {
  handleIntentMs: 100,
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
  enterMs?: number;
  leaveMs?: number;
  onSettle: (target: T | null) => void;
  timers?: HoverIntentTimers;
};

export type HoverIntent<T> = {
  enter: (target: T) => void;
  leave: () => void;
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
