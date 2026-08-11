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
import { useRef } from "react";

import { createProjectThread } from "@/client/api/projects-api";
import { invalidateProjectThreadData } from "@/client/query/project-invalidation";
import { DEFAULT_AGENT_SLUG, threadCreateAgentField } from "@/features/agents";

export function useCreateChat(projectId: string, onSelectThread: (threadId: string) => void) {
  const queryClient = useQueryClient();
  const createInFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: () =>
      createProjectThread(projectId, {
        ...threadCreateAgentField(DEFAULT_AGENT_SLUG),
      }),
    onSuccess: async (thread) => {
      await invalidateProjectThreadData(queryClient, projectId);
      onSelectThread(thread.id);
    },
  });

  const createChat = () => {
    if (createInFlight.current) return;
    createInFlight.current = true;
    mutation.reset();
    mutation.mutate(undefined, {
      onSettled: () => {
        createInFlight.current = false;
      },
    });
  };

  return {
    createChat,
    creating: mutation.isPending,
    createError: mutation.error,
    resetCreateError: mutation.reset,
  };
}
