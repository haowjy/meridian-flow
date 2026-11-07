const PRESS_SLOP_PX = 4;

/**
 * Whether a pointer has travelled far enough from its press to be a drag.
 * Straight-line distance, so every press follower agrees on one measure.
 */
export function pastSlop(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= PRESS_SLOP_PX;
}

type PressHost = {
  /**
   * The press travelled past the slop, at `at` (the move, or the release of a
   * flick that sent none). Record `at` before doing anything that dispatches:
   * a late lift must drop where the button came up, not where it went down.
   * Returns the handler for every move from `at` on.
   */
  lift(at: MouseEvent): (event: MouseEvent) => void;
  /** Tracking is over, once: released without a lift (`click`) or after one (`drop`), or lost or stopped (`cancel`, `at` null). */
  end(how: "click" | "drop" | "cancel", at: MouseEvent | null): void;
};

/** What the tracker reads of the press: a DOM `mousedown` or `pointerdown`, or React's `pointerdown`. */
export type PressStart = Pick<MouseEvent, "type" | "clientX" | "clientY"> & { pointerId?: number };

/**
 * Follows one press and decides click or lift. A `mousedown` ends on `mouseup`
 * and a `pointerdown` on `pointerup`: a handle that prevents `pointerdown` gets
 * no mouse events, and a touch tap's `pointerup` comes before its `mousedown`.
 * A `pointermove` without the left bit counts as a release. Returns `stop`.
 */
export function trackPress(press: PressStart, host: PressHost): () => void {
  const ac = new AbortController();
  const listen = <K extends keyof WindowEventMap>(
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    capture = false,
  ) => window.addEventListener(type, handler, { capture, signal: ac.signal });
  const byPointer = press.type === "pointerdown";
  const mine = (event: PointerEvent) =>
    byPointer ? event.pointerId === press.pointerId : event.pointerType !== "touch";
  let move: ((event: MouseEvent) => void) | null = null;

  const end = (how: "click" | "drop" | "cancel", at: MouseEvent | null) => {
    if (ac.signal.aborted) return;
    ac.abort();
    host.end(how, at);
  };

  const follow = (event: MouseEvent) => {
    if (!move && pastSlop(event.clientX - press.clientX, event.clientY - press.clientY)) {
      move = host.lift(event);
      // The lift can end the press itself (a peer's edit in its first transaction).
      if (ac.signal.aborted) return;
    }
    move?.(event);
  };

  const release = (event: MouseEvent) => {
    follow(event);
    if (move) {
      // The `click` after a lift is not a click (the link surface would follow a link).
      window.addEventListener("click", (click) => click.stopPropagation(), {
        capture: true,
        once: true,
        signal: AbortSignal.timeout(100),
      });
    }
    end(move ? "drop" : "click", event);
  };

  const lost = (event?: PointerEvent) => {
    if (!event || mine(event)) end("cancel", null);
  };

  listen(
    "pointermove",
    (event) => {
      if (!mine(event)) return;
      // The button came up where we heard nothing; ending here also keeps a
      // `mouseup` that follows from being heard twice.
      if (!(event.buttons & 1)) release(event);
      else follow(event);
    },
    true,
  );
  if (byPointer) {
    listen("pointerup", (event) => {
      if (mine(event) && event.button === 0) release(event);
    });
    listen("lostpointercapture", lost);
  } else {
    listen("mouseup", (event) => {
      if (event.button === 0) release(event);
    });
  }
  listen("pointercancel", lost, true);
  listen("blur", () => lost());

  return () => end("cancel", null);
}
