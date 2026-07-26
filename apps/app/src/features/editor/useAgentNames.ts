/**
 * useAgentNames — stable agent-name lookup for peer-mark labels.
 *
 * Owns the thread-list read so `EditorView` never holds the query result: that
 * array's identity changes on every refetch, and the thread list is invalidated
 * by every turn start, stream frame and disposition. Feeding a store instead
 * keeps turn-rate churn out of the editor's construction state.
 */
import { useEffect, useState } from "react";

import { useProjectThreads } from "@/client/query/useProjectThreads";
import { type AgentNameStore, createAgentNameStore } from "@/core/editor/agent-name-store";

export function useAgentNames(
  projectId: string | undefined,
  options: { enabled: boolean },
): AgentNameStore {
  const [store] = useState(createAgentNameStore);
  const { threads } = useProjectThreads(projectId ?? "", {
    enabled: Boolean(projectId) && options.enabled,
  });

  useEffect(() => {
    // Untitled threads contribute nothing: the mark label falls back to "AI",
    // which reads better than the thread list's "New chat" placeholder.
    const names = new Map<string, string>();
    for (const thread of threads ?? []) {
      const title = thread.title?.trim();
      if (title) names.set(thread.id, title);
    }
    store.replace(names);
  }, [store, threads]);

  return store;
}
