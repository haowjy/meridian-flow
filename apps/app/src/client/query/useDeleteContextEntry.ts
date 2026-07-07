import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { contextRequestOptionsForScheme, useContextWorkId } from "./useContextWorkId";

/**
 * Mutation hook for deleting a file or folder from a context scheme's tree.
 *
 * On success, invalidates the cached context tree so the deleted entry
 * disappears.
 */
export function useDeleteContextEntry(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options?: { activeThreadId?: string | null },
) {
  const queryClient = useQueryClient();
  const workId = useContextWorkId(projectId, options?.activeThreadId ?? null);
  const contextOpts = contextRequestOptionsForScheme(scheme, workId);
  return useMutation({
    mutationFn: (args: { path: string }) =>
      deleteContextEntry(projectId, scheme, args, contextOpts),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.contextTree(
          projectId,
          scheme,
          isWorkScopedProjectContextScheme(scheme) ? workId : undefined,
        ),
      });
    },
  });
}
