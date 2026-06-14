// @ts-nocheck
/**
 * useCreateChat — the project workspace "new chat" action.
 *
 * Purpose: one mutation that creates a thread, invalidates the thread-data
 * cache, then selects the new thread. Backed by TanStack Query `useMutation`
 * (not hand-rolled state) so pending/error lifecycle uses the standard layer.
 * `creating` drives disabled state; the guard against double-submit is the
 * mutation's own in-flight check.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createProjectThread } from "@/client/api/projects-api";
import { invalidateProjectThreadData } from "@/client/query/project-invalidation";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";

export function useCreateChat(projectId: string, onSelectThread: (threadId: string) => void) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => createProjectThread(projectId, { currentAgent: DEFAULT_AGENT_SLUG }),
    onSuccess: async (thread) => {
      await invalidateProjectThreadData(queryClient, projectId);
      onSelectThread(thread.id);
    },
  });

  const createChat = () => {
    if (mutation.isPending) return;
    mutation.mutate();
  };

  return { createChat, creating: mutation.isPending };
}
