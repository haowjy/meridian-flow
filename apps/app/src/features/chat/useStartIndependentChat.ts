import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useProjectActions, useProjectStore, useThreadActions } from "@/client/stores";
import { startIndependentChat } from "@/lib/optimistic-project";

/**
 * Start an independent (project-less) chat. Optionally seeds the first message;
 * empty text opens with the composer focused. Navigates to `/chat/:threadId`.
 */
export function useStartIndependentChat() {
  const navigate = useNavigate();
  const projectActions = useProjectActions();
  const threadActions = useThreadActions();
  const now = useProjectStore((s) => s.now);

  return useCallback(
    (text?: string) => {
      startIndependentChat({ text, projectActions, threadActions, navigate, now });
    },
    [navigate, now, projectActions, threadActions],
  );
}
