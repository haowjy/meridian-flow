/** Announce only meaningful transitions, never individual upload or organize ticks. */

import { useEffect, useRef } from "react";
import { announce } from "@/client/stores/thread-store/announcements";
import type { ToastState } from "./toast-presentation";
export function useImportMilestone(state: ToastState, title: string) {
  const last = useRef<ToastState | null>(null);
  useEffect(() => {
    if (
      last.current !== state &&
      ["reading", "done", "needs-look", "failed", "refused", "paused"].includes(state)
    )
      announce(title);
    last.current = state;
  }, [state, title]);
}
