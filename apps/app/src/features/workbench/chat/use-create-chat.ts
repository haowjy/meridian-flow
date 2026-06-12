// @ts-nocheck
/**
 * useCreateChat — the workbench workspace "new chat" action.
 *
 * Purpose: one mutation that creates a thread, invalidates the thread-data
 * cache, then selects the new thread. Backed by TanStack Query `useMutation`
 * (not hand-rolled state) so pending/error lifecycle uses the standard layer.
 * `creating` drives disabled state; the guard against double-submit is the
 * mutation's own in-flight check.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createWorkbenchThread } from "@/client/api/workbenches-api";
import { invalidateWorkbenchThreadData } from "@/client/query/workbench-invalidation";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";

export function useCreateChat(workbenchId: string, onSelectThread: (threadId: string) => void) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => createWorkbenchThread(workbenchId, { currentAgent: DEFAULT_AGENT_SLUG }),
    onSuccess: async (thread) => {
      await invalidateWorkbenchThreadData(queryClient, workbenchId);
      onSelectThread(thread.id);
    },
  });

  const createChat = () => {
    if (mutation.isPending) return;
    mutation.mutate();
  };

  return { createChat, creating: mutation.isPending };
}
