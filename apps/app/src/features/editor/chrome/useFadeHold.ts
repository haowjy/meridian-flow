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
