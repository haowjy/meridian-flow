import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteContextEntry } from "@/client/api/projects-api";
import { contextRequestOptionsForScheme } from "./context-request-options";
import { projectQueryKeys } from "./project-query-keys";

/**
 * Mutation hook for deleting a file or folder from a context scheme's tree.
 *
 * On success, invalidates the cached context tree so the deleted entry
 * disappears.
 */
export function useDeleteContextEntry(projectId: string, scheme: ProjectContextTreeScheme) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { path: string; workId: string | null }) =>
      deleteContextEntry(
        projectId,
        scheme,
        args,
        contextRequestOptionsForScheme(scheme, args.workId),
      ),
    onSuccess: (_result, args) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.contextTree(
          projectId,
          scheme,
          isWorkScopedProjectContextScheme(scheme) ? args.workId : undefined,
        ),
      });
    },
  });
}
