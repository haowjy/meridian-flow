// @ts-nocheck
/**
 * useCreateBoundWorkbenchThread — creates a server thread bound to an agent slug.
 *
 * Shared by the Library "Test this agent" action and the composer fork affordance.
 * Each call creates a fresh thread (capability freeze — never reuse).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createWorkbenchThread } from "@/client/api/workbenches-api";
import { invalidateWorkbenchThreadData } from "@/client/query/workbench-invalidation";
import { useThreadActions } from "@/client/stores";
import { defaultThreadTitle } from "@/lib/thread-title";

import { wireAgentSlug } from "./constants";

export function useCreateBoundWorkbenchThread(workbenchId: string) {
  const threadActions = useThreadActions();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentSlug, title }: { agentSlug: string; title?: string }) => {
      const wireSlug = wireAgentSlug(agentSlug);
      const thread = await createWorkbenchThread(workbenchId, {
        title: title ?? defaultThreadTitle(),
        ...(wireSlug ? { currentAgent: wireSlug } : {}),
      });
      threadActions.ensureThread(thread);
      await invalidateWorkbenchThreadData(queryClient, workbenchId);
      return thread;
    },
  });
}
