/**
 * useCreateBoundProjectThread — creates a server thread bound to an agent slug.
 *
 * Shared by the Library "Test this agent" action and the composer fork affordance.
 * Each call creates a fresh thread (capability freeze — never reuse).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createProjectThread } from "@/client/api/projects-api";
import { invalidateProjectThreadData } from "@/client/query/project-invalidation";
import { useThreadActions } from "@/client/stores";
import { defaultThreadTitle } from "@/lib/thread-title";

import { threadCreateAgentField } from "./constants";

export function useCreateBoundProjectThread(projectId: string) {
  const threadActions = useThreadActions();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentSlug, title }: { agentSlug: string; title?: string }) => {
      const thread = await createProjectThread(projectId, {
        title: title ?? defaultThreadTitle(),
        ...threadCreateAgentField(agentSlug),
      });
      threadActions.ensureThread(thread);
      await invalidateProjectThreadData(queryClient, projectId);
      return thread;
    },
  });
}
