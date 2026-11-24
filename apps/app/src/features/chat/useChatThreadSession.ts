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
