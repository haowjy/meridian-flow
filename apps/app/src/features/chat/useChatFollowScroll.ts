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
  /**
   * Re-acquire follow (pill click, submit): flips mode synchronously — so the
   * pill hides in the same commit — then pins instantly. Instant on purpose: a
   * smooth scroll here would be cancelled by the very next content-revision pin,
   * so the API only offers the behavior it can actually deliver.
   */
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

  // Single write path for mode: ref for callbacks, state for rendering.
  const commitMode = useCallback((next: FollowMode) => {
    if (modeRef.current === next) return;
    modeRef.current = next;
    setMode(next);
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

  const enterFollow = useCallback(() => {
    commitMode("follow");
    const el = scrollRef.current;
    if (!el) return;
    beginProgrammaticScroll();
    el.scrollTop = maxScrollTop(el);
    lastScrollTopRef.current = el.scrollTop;
  }, [beginProgrammaticScroll, commitMode, scrollRef]);

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
          if (farAboveBottom && currentTop < prevTop - 1) commitMode("free");
          return;
        }

        // Near-bottom ALWAYS wins (invariant 2 in the header).
        if (isNearBottom(el)) {
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
  }, [commitMode, scrollRef]);

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
