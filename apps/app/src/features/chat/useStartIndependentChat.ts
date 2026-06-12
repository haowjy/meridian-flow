// @ts-nocheck
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useThreadActions, useWorkbenchActions, useWorkbenchStore } from "@/client/stores";
import { startIndependentChat } from "@/lib/optimistic-workbench";

/**
 * Start an independent (workbench-less) chat. Optionally seeds the first message;
 * empty text opens with the composer focused. Navigates to `/chat/:threadId`.
 */
export function useStartIndependentChat() {
  const navigate = useNavigate();
  const workbenchActions = useWorkbenchActions();
  const threadActions = useThreadActions();
  const now = useWorkbenchStore((s) => s.now);

  return useCallback(
    (text?: string) => {
      startIndependentChat({ text, workbenchActions, threadActions, navigate, now });
    },
    [navigate, now, workbenchActions, threadActions],
  );
}
