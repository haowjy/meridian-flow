import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { renameContextEntry } from "@/client/api/projects-api";
import { contextRequestOptionsForScheme } from "./context-request-options";
import { projectQueryKeys } from "./project-query-keys";

/**
 * Mutation hook for renaming a file or folder in a context scheme's tree.
 *
 * On success, invalidates the cached context tree so the renamed entry
 * appears under its new name.
 */
export function useRenameContextEntry(projectId: string, scheme: ProjectContextTreeScheme) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { path: string; newName: string; workId: string | null }) =>
      renameContextEntry(
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
