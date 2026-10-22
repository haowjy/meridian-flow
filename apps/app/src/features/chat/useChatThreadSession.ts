/**
 * useChatThreadSession — marks the active streaming thread for shell chrome.
 *
 * Rendering reads `Turn[]` directly from ThreadStore, and the mounted subscriber
 * (`useThreadSnapshotSync`) owns the transport subscription. Scroll/follow is owned by the
 * virtualized viewport inside `TurnList`, so there is no scroll-parent seam here.
 */
import { useEffect } from "react";

import type { ThreadStoreActions } from "@/client/stores";

export function useChatThreadSession({
  threadId,
  actions,
  isStreaming,
  projectId,
}: {
  threadId: string;
  projectId: string;
  actions: ThreadStoreActions;
  isStreaming: boolean;
}) {
  useEffect(() => {
    if (!isStreaming) return;
    actions.setStreamingThreadId(threadId, projectId);
    return () => {
      actions.setStreamingThreadId(null);
    };
  }, [actions, isStreaming, projectId, threadId]);
}
