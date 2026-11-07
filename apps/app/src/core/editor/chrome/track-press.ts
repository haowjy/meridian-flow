/** Pointer travel that turns a press into a drag, ProseMirror's own slop. Hypot, so a 2px diagonal wobble stays a click. */
export const PRESS_SLOP_PX = 4;

export function pastSlop(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= PRESS_SLOP_PX;
}

/** What a press became once it travelled past the slop. Both ends are safe to call again. */
export type PressLift = {
  /** The pointer moved; the first call is the event that lifted it. */
  move(event: MouseEvent): void;
  /** The button came up. */
  release(): void;
  /** The press was lost (cancelled, capture lost, window blurred). */
  cancel(): void;
};

export type PressHost = {
  /**
   * The press travelled past the slop, at `at` (the move, or the release of a
   * flick that sent none). Record `at` before doing anything that dispatches:
   * a late lift must drop where the button came up, not where it went down.
   */
  lift(at: MouseEvent): PressLift;
  /** The button came up without a lift. */
  click(release: MouseEvent): void;
  /** Tracking is over, however it ended (including `stop`). */
  end(): void;
};

/**
 * Follows one press and decides click or lift, knowing nothing of drags or
 * ProseMirror. A `mousedown` ends on `mouseup` and a `pointerdown` on
 * `pointerup`: a handle that prevents `pointerdown` gets no mouse events, and
 * a touch tap's `pointerup` comes before its `mousedown`. A release the page
 * never heard (`buttons` without the left bit on a `pointermove`) counts as
 * one. After a lift's release the `click` that follows is swallowed.
 * Returns `stop`, which ends tracking without calling the lift.
 */
export function trackPress(press: MouseEvent | PointerEvent, host: PressHost): () => void {
  const ac = new AbortController();
  const listen = (type: string, handler: (event: never) => void, capture = false) =>
    window.addEventListener(type, handler as EventListener, { capture, signal: ac.signal });
  const byPointer = press.type === "pointerdown";
  const mine = (event: PointerEvent) =>
    byPointer
      ? event.pointerId === (press as PointerEvent).pointerId
      : event.pointerType === "mouse";
  let lift: PressLift | null = null;
  let over = false;

  const stop = () => {
    if (over) return;
    over = true;
    ac.abort();
    host.end();
  };

  const follow = (event: MouseEvent) => {
    if (!lift && pastSlop(event.clientX - press.clientX, event.clientY - press.clientY)) {
      lift = host.lift(event);
    }
    lift?.move(event);
  };

  const release = (event: MouseEvent) => {
    follow(event);
    if (lift) {
      lift.release();
      // The `click` after a lift is not a click (the link surface would follow a link).
      window.addEventListener("click", (click) => click.stopPropagation(), {
        capture: true,
        once: true,
        signal: AbortSignal.timeout(100),
      });
    } else {
      host.click(event);
    }
    stop();
  };

  const lost = (event?: PointerEvent) => {
    if (event && !mine(event)) return;
    lift?.cancel();
    stop();
  };

  listen(
    "pointermove",
    (event: PointerEvent) => {
      if (!mine(event)) return;
      // The button came up where we heard nothing; ending here also keeps a
      // `mouseup` that follows from being heard twice.
      if (!(event.buttons & 1)) release(event);
      else follow(event);
    },
    true,
  );
  if (byPointer) {
    listen("pointerup", (event: PointerEvent) => {
      if (mine(event) && event.button === 0) release(event);
    });
    listen("lostpointercapture", lost);
  } else {
    listen("mouseup", (event: MouseEvent) => {
      if (event.button === 0) release(event);
    });
  }
  listen("pointercancel", lost, true);
  listen("blur", () => lost());

  return stop;
}
