/** Announce only meaningful transitions, never individual upload or organize ticks. */

import { useEffect, useRef } from "react";
import { announce } from "@/client/stores/thread-store/announcements";
import type { ImportState } from "./import-presentation";
export function useImportMilestone(state: ImportState, title: string) {
  const last = useRef<ImportState | null>(null);
  useEffect(() => {
    if (
      last.current !== state &&
      ["reading", "done", "needs-look", "failed", "paused"].includes(state)
    )
      announce(title);
    last.current = state;
  }, [state, title]);
}
