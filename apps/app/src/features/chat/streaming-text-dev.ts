// @ts-nocheck
/**
 * streaming-text-dev — DEV-ONLY playback throttling for streaming text.
 *
 * Reads `localStorage('meridian.debug.streamPlaybackCps')` and exposes a hook that
 * replays text at a fixed chars/second to simulate slow streaming during local
 * UI work. Owns the debug knob + rAF throttle; never used in production paths.
 */
import { useEffect, useRef, useState } from "react";

/** Dev-only: `localStorage.setItem('meridian.debug.streamPlaybackCps', '60')` then reload. */
export function readDebugStreamPlaybackCps(): number {
  try {
    const raw = localStorage.getItem("meridian.debug.streamPlaybackCps");
    if (!raw) {
      return 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Throttles displayed text to simulate slow streaming (dev tooling only). */
export function useDebugStreamPlayback(target: string, cps: number): string {
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (target.length < displayedRef.current.length) {
      displayedRef.current = target;
      setDisplayed(target);
    }
  }, [target]);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;
      const goal = targetRef.current;
      let current = displayedRef.current;
      if (goal.length < current.length) {
        current = goal;
      } else if (current.length < goal.length) {
        const step = Math.max(1, Math.floor((cps * dt) / 1000));
        current = goal.slice(0, Math.min(current.length + step, goal.length));
      }
      if (current !== displayedRef.current) {
        displayedRef.current = current;
        setDisplayed(current);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cps]);

  return displayed;
}
