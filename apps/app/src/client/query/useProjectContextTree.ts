import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getProjectContextTree } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { contextRequestOptionsForScheme, useContextWorkId } from "./useContextWorkId";

/**
 * Project context tree for the given scheme (`manuscript`, `kb`, `work`, or `user`).
 * include the persisted `documents.id`; the editor must use that id, not the
 * display path.
 *
 * The scheme is required and threaded into both the query key and the API
 * call — distinct schemes back distinct trees and must cache independently.
 * Work-scoped schemes (`work`, `uploads`) also key and query by `workId`.
 */
export function useProjectContextTree(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options?: { enabled?: boolean; activeThreadId?: string | null },
): {
  tree: ProjectContextTreeDirectory | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const workId = useContextWorkId(projectId, options?.activeThreadId ?? null);
  const workScoped = isWorkScopedProjectContextScheme(scheme);
  const enabled = (options?.enabled ?? true) && (!workScoped || workId !== null);
  const contextOpts = contextRequestOptionsForScheme(scheme, workId);
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: projectQueryKeys.contextTree(projectId, scheme, workId),
    queryFn: () => getProjectContextTree(projectId, scheme, contextOpts),
    staleTime: 30_000,
    enabled,
  });

  return {
    tree: data?.tree ?? null,
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
