import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createContextEntry } from "@/client/api/projects-api";
import { contextRequestOptionsForScheme } from "./context-request-options";
import { projectQueryKeys } from "./project-query-keys";

/**
 * Mutation hook for creating a file or folder inside a context tree. The
 * target scheme travels with each mutation (not the hook) so one instance can
 * serve saves whose destination the writer picks at submit time.
 *
 * On success, invalidates the cached context tree for that scheme so the new
 * entry appears in `ContextTreePanel` on the next read.
 */
export function useCreateContextEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      scheme: ProjectContextTreeScheme;
      type: "file" | "folder";
      path: string;
      content?: string;
      workId: string | null;
    }) =>
      createContextEntry(
        projectId,
        args.scheme,
        { type: args.type, path: args.path, content: args.content },
        contextRequestOptionsForScheme(args.scheme, args.workId),
      ),
    onSuccess: (_result, args) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.contextCatalogView(
          projectId,
          args.scheme,
          isWorkScopedProjectContextScheme(args.scheme) ? args.workId : undefined,
        ),
      });
    },
  });
}
