/**
 * Keep the last value around while its surface fades out.
 *
 * A surface that unmounts the instant its target goes away has nothing left to
 * animate, and one that keeps the value forever leaves an invisible element
 * anchored to a paragraph that may already be gone. This holds it for exactly
 * one fade.
 *
 * The timer is exit animation, never hover timing: the kernel's hover intent
 * has already decided the approach is over by the time the value goes null.
 */

import { useEffect, useState } from "react";

import { CHROME_TIMING } from "@/core/editor/chrome";

export function useFadeHold<T>(value: T | null): T | null {
  const [held, setHeld] = useState<T | null>(value);

  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      return;
    }
    const timer = window.setTimeout(() => setHeld(null), CHROME_TIMING.fadeMs);
    return () => window.clearTimeout(timer);
  }, [value]);

  return value ?? held;
}
