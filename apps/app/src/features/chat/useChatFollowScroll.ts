import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type FollowMode = "follow" | "free";

const BOTTOM_THRESHOLD_PX = 32;
const AUTOSCROLL_GUARD_MS = 180;

type Options = {
  scrollRef: RefObject<HTMLElement | null>;
  contentHeight: number;
  initialMode?: FollowMode;
};

function maxScrollTopFrom(contentHeight: number, viewportHeight: number): number {
  return Math.max(contentHeight - viewportHeight, 0);
}

export function useChatFollowScroll({
  scrollRef,
  contentHeight,
  initialMode = "follow",
}: Options): {
  mode: FollowMode;
  currentMode: () => FollowMode;
  enterFollow: () => void;
  releaseFollow: () => void;
} {
  const [mode, setMode] = useState<FollowMode>(initialMode);
  // keep: commitMode is the only writer of modeRef; adding render-time sync would let a stale render clobber a transition committed between renders, so callbacks read the ref before React commits.
  const modeRef = useRef<FollowMode>(initialMode);

  const programmaticGuardRef = useRef(false);
  const guardTimeoutRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const contentHeightRef = useRef(contentHeight);
  const viewportHeightRef = useRef(0);
  contentHeightRef.current = contentHeight;

  const maxScrollTop = useCallback(() => {
    const el = scrollRef.current;
    if (viewportHeightRef.current === 0 && el) viewportHeightRef.current = el.clientHeight;
    return maxScrollTopFrom(contentHeightRef.current, viewportHeightRef.current);
  }, [scrollRef]);

  const commitMode = useCallback((next: FollowMode) => {
    modeRef.current = next;
    setMode((current) => (current === next ? current : next));
  }, []);

  const beginProgrammaticScroll = useCallback(() => {
    programmaticGuardRef.current = true;
    if (guardTimeoutRef.current !== null) clearTimeout(guardTimeoutRef.current);
    guardTimeoutRef.current = window.setTimeout(() => {
      programmaticGuardRef.current = false;
      guardTimeoutRef.current = null;
    }, AUTOSCROLL_GUARD_MS);
  }, []);

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

  const releaseFollow = useCallback(() => commitMode("free"), [commitMode]);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let reconcileTimer: number | null = null;

    const onScroll = () => {
      if (reconcileTimer !== null) return;
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = null;
        const currentTop = el.scrollTop;
        const prevTop = lastScrollTopRef.current;
        const max = maxScrollTop();
        const scrollHeight = el.scrollHeight;
        const shrunk = lastScrollHeightRef.current - scrollHeight;
        lastScrollHeightRef.current = scrollHeight;
        const movedUp = currentTop < prevTop - 1 && prevTop - currentTop > shrunk + 1;
        lastScrollTopRef.current = currentTop;

        if (programmaticGuardRef.current) {
          const farAboveBottom = max - currentTop > 2 * BOTTOM_THRESHOLD_PX;
          if (farAboveBottom && movedUp) commitMode("free");
          return;
        }

        if (max - currentTop <= BOTTOM_THRESHOLD_PX) {
          commitMode("follow");
          return;
        }

        if (movedUp) commitMode("free");
      }, 1);
    };

    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    };
  }, [commitMode, maxScrollTop, scrollRef]);

  useLayoutEffect(() => {
    if (mode !== "follow") return;
    const el = scrollRef.current;
    if (!el) return;
    const top = maxScrollTop();
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

  const currentMode = useCallback(() => modeRef.current, []);

  return { mode, currentMode, enterFollow, releaseFollow };
}
