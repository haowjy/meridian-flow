import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { renameContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { contextRequestOptionsForScheme, useContextWorkId } from "./useContextWorkId";

/**
 * Mutation hook for renaming a file or folder in a context scheme's tree.
 *
 * On success, invalidates the cached context tree so the renamed entry
 * appears under its new name.
 */
export function useRenameContextEntry(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options?: { activeThreadId?: string | null },
) {
  const queryClient = useQueryClient();
  const workId = useContextWorkId(projectId, options?.activeThreadId ?? null);
  const contextOpts = contextRequestOptionsForScheme(scheme, workId);
  return useMutation({
    mutationFn: (args: { path: string; newName: string }) =>
      renameContextEntry(projectId, scheme, args, contextOpts),
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
