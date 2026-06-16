import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { contextRequestOptionsForScheme, useContextWorkId } from "./useContextWorkId";

/**
 * Mutation hook for creating a file or folder inside the given scheme's
 * context tree.
 *
 * On success, invalidates the cached context tree for that scheme so the new
 * entry appears in `ContextTreePanel` on the next read.
 */
export function useCreateContextEntry(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options?: { activeThreadId?: string | null },
) {
  const queryClient = useQueryClient();
  const workId = useContextWorkId(projectId, options?.activeThreadId ?? null);
  const contextOpts = contextRequestOptionsForScheme(scheme, workId);
  return useMutation({
    mutationFn: (args: { type: "file" | "folder"; path: string; content?: string }) =>
      createContextEntry(projectId, scheme, args, contextOpts),
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
