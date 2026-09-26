/** Coordinates follow/free scroll policy for the transcript. */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type FollowMode = "follow" | "free";

/** Distance from the bottom that still counts as the live edge (px). */
const BOTTOM_THRESHOLD_PX = 32;
/** Self-scroll guard window. */
const AUTOSCROLL_GUARD_MS = 180;

type Options = {
  scrollRef: RefObject<HTMLElement | null>;
  contentHeight: number;
};

function maxScrollTopFrom(contentHeight: number, viewportHeight: number): number {
  return Math.max(contentHeight - viewportHeight, 0);
}

export function useChatFollowScroll({ scrollRef, contentHeight }: Options): {
  mode: FollowMode;
  /** Re-acquire follow (pill click, submit): flips mode synchronously — so the pill hides in the same commit — then pins instantly. */
  enterFollow: () => void;
} {
  const [mode, setMode] = useState<FollowMode>("follow");
  // `commitMode` below is the ONLY writer of this ref (no render-time sync — a
  // render with stale state would clobber a transition committed between
  // renders). The ref is therefore always the freshest intended mode, which is
  // what event/timer callbacks must read in the gap before React commits.
  const modeRef = useRef<FollowMode>("follow");

  const programmaticGuardRef = useRef(false);
  const guardTimeoutRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  // Cached geometry: the pin avoids reading `scrollHeight`/`clientHeight`.
  const contentHeightRef = useRef(contentHeight);
  const viewportHeightRef = useRef(0);
  contentHeightRef.current = contentHeight;

  const maxScrollTop = useCallback(() => {
    const el = scrollRef.current;
    // Viewport height is unknown until the observer has run once; a one-time
    // read here keeps the first pin from overshooting into a clamp.
    if (viewportHeightRef.current === 0 && el) viewportHeightRef.current = el.clientHeight;
    return maxScrollTopFrom(contentHeightRef.current, viewportHeightRef.current);
  }, [scrollRef]);

  // Single write path for mode: ref for callbacks, state for rendering. Always
  // offer the state update: React may still have an older queued render even
  // when the imperative ref already holds `next`.
  const commitMode = useCallback((next: FollowMode) => {
    modeRef.current = next;
    setMode((current) => (current === next ? current : next));
  }, []);

  // Open (or re-arm) the self-scroll guard window before any programmatic write.
  const beginProgrammaticScroll = useCallback(() => {
    programmaticGuardRef.current = true;
    if (guardTimeoutRef.current !== null) clearTimeout(guardTimeoutRef.current);
    guardTimeoutRef.current = window.setTimeout(() => {
      programmaticGuardRef.current = false;
      guardTimeoutRef.current = null;
    }, AUTOSCROLL_GUARD_MS);
  }, []);

  // Track the viewport's height without reading it at pin time.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      viewportHeightRef.current = el.clientHeight;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef]);

  const enterFollow = useCallback(() => {
    commitMode("follow");
    const el = scrollRef.current;
    if (!el) return;
    beginProgrammaticScroll();
    el.scrollTop = maxScrollTop();
    lastScrollTopRef.current = el.scrollTop;
  }, [beginProgrammaticScroll, commitMode, maxScrollTop, scrollRef]);

  // Deliberate upward intent releases immediately, independent of geometry.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) commitMode("free");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
        commitMode("free");
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (startY == null || currentY == null) return;
      // Finger moving down = content moving up = reading history.
      if (currentY > startY + 2) commitMode("free");
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [commitMode, scrollRef]);

  // Geometry reconcile: silent re-lock at the bottom; scrollbar-drag-up releases.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let reconcileTimer: number | null = null;

    const onScroll = () => {
      // Defer a tick (like use-stick-to-bottom) so resize + scroll ordering
      // settles. Coalesced: one pending reconcile serves any burst of scroll
      // events — it reads the freshest geometry when it fires, so later events
      // in the burst add nothing.
      if (reconcileTimer !== null) return;
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = null;
        const currentTop = el.scrollTop;
        const prevTop = lastScrollTopRef.current;
        const max = maxScrollTop();
        // Keep the baseline fresh even for guarded writes, so the next real user
        // delta is measured from where the viewport actually is.
        lastScrollTopRef.current = currentTop;

        if (programmaticGuardRef.current) {
          // Value-aware escape hatch: our own writes land AT the live edge, so a
          // guarded event that moved UP and sits well above the bottom band can
          // only be the user (scrollbar drag mid-stream — the guard is re-armed
          // continuously while streaming pins, so without this the drag would be
          // swallowed and the next pin would yank the reader back down).
          const farAboveBottom = max - currentTop > 2 * BOTTOM_THRESHOLD_PX;
          if (farAboveBottom && currentTop < prevTop - 1) commitMode("free");
          return;
        }

        // Near-bottom ALWAYS wins (invariant 2 in the header).
        if (max - currentTop <= BOTTOM_THRESHOLD_PX) {
          commitMode("follow");
          return;
        }

        if (currentTop < prevTop - 1) commitMode("free");
      }, 1);
    };

    lastScrollTopRef.current = el.scrollTop;
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    };
  }, [commitMode, maxScrollTop, scrollRef]);

  // Follow mode: pin to the bottom on every content revision, before paint.
  useLayoutEffect(() => {
    if (mode !== "follow") return;
    const el = scrollRef.current;
    if (!el) return;
    const top = maxScrollTop();
    // Guard only when actually writing: an idle pin (already at the bottom) must
    // not open a guard window that swallows the user's next real scroll.
    if (el.scrollTop !== top) {
      beginProgrammaticScroll();
      el.scrollTop = top;
    }
    lastScrollTopRef.current = el.scrollTop;
  }, [contentHeight, mode, beginProgrammaticScroll, maxScrollTop, scrollRef]);

  useEffect(() => {
    return () => {
      if (guardTimeoutRef.current !== null) clearTimeout(guardTimeoutRef.current);
    };
  }, []);

  return { mode, enterFollow };
}
