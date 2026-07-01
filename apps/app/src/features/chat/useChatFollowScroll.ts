/**
 * useChatFollowScroll — the explicit `follow | free` policy machine for the chat
 * transcript viewport.
 *
 * The transcript has exactly two policy states, and this hook is their single
 * owner:
 *   - `follow` — pinned to the live edge; every content revision re-pins the
 *     viewport to the bottom; the jump-to-latest pill is hidden.
 *   - `free`   — the reader is reading history; nothing auto-scrolls; the pill
 *     is visible.
 *
 * Geometry (distance from bottom) only FEEDS transitions — it is never the
 * state. Deriving "at bottom" per-frame from scroll offsets is what made the
 * pill flicker and follow-release feel inconsistent.
 *
 * Transitions:
 *   → free:   deliberate upward intent — wheel up, downward touch drag,
 *             ArrowUp/PageUp/Home — releases IMMEDIATELY, plus scrollbar drags
 *             that move up while genuinely away from the bottom.
 *   → follow: reaching the bottom band (silent re-lock), or an explicit
 *             `enterFollow()` (jump-to-latest pill, submit).
 *
 * Two non-obvious invariants, both learned the hard way (see
 * work/chat-follow-state/study/SYNTHESIS.md in meridian-flow-docs):
 *   1. The self-scroll guard is a TIME window (~180ms, re-armed on every
 *      programmatic write), not a rAF latch. One pin triggers a burst of
 *      ResizeObserver/measure scroll events; a frame latch clears mid-burst and
 *      the tail events false-read as user scroll-up.
 *   2. In the scroll handler, the near-bottom check wins BEFORE the "moved up"
 *      release check — otherwise a 1px downward settle at the bottom
 *      false-releases. A ~1px upward deadzone guards sub-pixel jitter.
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type FollowMode = "follow" | "free";

/** Distance from the bottom that still counts as the live edge (px). */
const BOTTOM_THRESHOLD_PX = 32;
/**
 * Self-scroll guard window. Mirrors shadcn's message-scroller
 * (`AUTOSCROLLING_CLEAR_DELAY = 180ms`); react-virtuoso uses 200ms for the
 * same job. Re-armed on every programmatic write so a whole streaming burst
 * stays inside one guarded window.
 */
const AUTOSCROLL_GUARD_MS = 180;

type Options = {
  scrollRef: RefObject<HTMLElement | null>;
  /**
   * Bump whenever transcript content/size may have changed (turn appended,
   * streaming row grew, composer inset changed). While in `follow`, every bump
   * re-pins the viewport to the bottom before paint. The virtualizer's
   * `getTotalSize()` is a good revision: it changes on append AND on measured
   * row growth, and each change re-renders the owner.
   */
  contentRevision: number;
};

function maxScrollTop(el: HTMLElement): number {
  return Math.max(el.scrollHeight - el.clientHeight, 0);
}

function isNearBottom(el: HTMLElement): boolean {
  return maxScrollTop(el) - el.scrollTop <= BOTTOM_THRESHOLD_PX;
}

export function useChatFollowScroll({ scrollRef, contentRevision }: Options): {
  mode: FollowMode;
  /** Re-acquire follow (pill click, submit): flips mode synchronously, then scrolls. */
  enterFollow: (behavior?: ScrollBehavior) => void;
} {
  const [mode, setMode] = useState<FollowMode>("follow");
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const programmaticGuardRef = useRef(false);
  const guardTimeoutRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);

  // Open (or re-arm) the self-scroll guard window before any programmatic write.
  const beginProgrammaticScroll = useCallback(() => {
    programmaticGuardRef.current = true;
    if (guardTimeoutRef.current !== null) clearTimeout(guardTimeoutRef.current);
    guardTimeoutRef.current = window.setTimeout(() => {
      programmaticGuardRef.current = false;
      guardTimeoutRef.current = null;
    }, AUTOSCROLL_GUARD_MS);
  }, []);

  const enterFollow = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      // Mode flips first so the pill hides the same frame as the jump.
      setMode("follow");
      modeRef.current = "follow";
      const el = scrollRef.current;
      if (!el) return;
      beginProgrammaticScroll();
      el.scrollTo({ top: maxScrollTop(el), behavior });
    },
    [beginProgrammaticScroll, scrollRef],
  );

  const releaseToFree = useCallback(() => {
    if (modeRef.current === "free") return;
    modeRef.current = "free";
    setMode("free");
  }, []);

  // Deliberate upward intent releases immediately, independent of geometry.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) releaseToFree();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
        releaseToFree();
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
      if (currentY > startY + 2) releaseToFree();
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
  }, [releaseToFree, scrollRef]);

  // Geometry reconcile: silent re-lock at the bottom; scrollbar-drag-up releases.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      // Defer a tick (like use-stick-to-bottom) so resize + scroll ordering settles.
      setTimeout(() => {
        const currentTop = el.scrollTop;
        const prevTop = lastScrollTopRef.current;
        // Keep the baseline fresh even for guarded writes, so the next real user
        // delta is measured from where the viewport actually is.
        lastScrollTopRef.current = currentTop;

        if (programmaticGuardRef.current) {
          // Value-aware escape hatch: our own writes land AT the live edge, so a
          // guarded event that moved UP and sits well above the bottom band can
          // only be the user (scrollbar drag mid-stream — the guard is re-armed
          // continuously while streaming pins, so without this the drag would be
          // swallowed and the next pin would yank the reader back down).
          const farAboveBottom = maxScrollTop(el) - currentTop > 2 * BOTTOM_THRESHOLD_PX;
          if (farAboveBottom && currentTop < prevTop - 1) releaseToFree();
          return;
        }

        // Near-bottom ALWAYS wins (invariant 2 in the header).
        if (isNearBottom(el)) {
          if (modeRef.current !== "follow") {
            modeRef.current = "follow";
            setMode("follow");
          }
          return;
        }

        if (currentTop < prevTop - 1) releaseToFree();
      }, 1);
    };

    lastScrollTopRef.current = el.scrollTop;
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [releaseToFree, scrollRef]);

  // Follow mode: pin to the bottom on every content revision, before paint.
  useLayoutEffect(() => {
    if (mode !== "follow") return;
    const el = scrollRef.current;
    if (!el) return;
    const top = maxScrollTop(el);
    // Guard only when actually writing: an idle pin (already at the bottom) must
    // not open a guard window that swallows the user's next real scroll.
    if (el.scrollTop !== top) {
      beginProgrammaticScroll();
      el.scrollTop = top;
    }
    lastScrollTopRef.current = el.scrollTop;
  }, [contentRevision, mode, beginProgrammaticScroll, scrollRef]);

  useEffect(() => {
    return () => {
      if (guardTimeoutRef.current !== null) clearTimeout(guardTimeoutRef.current);
    };
  }, []);

  return { mode, enterFollow };
}
