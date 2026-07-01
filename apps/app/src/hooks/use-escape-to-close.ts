/**
 * useEscapeToClose — closes overlay chrome when the writer presses Escape.
 */
import { useEffect } from "react";

export function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}
