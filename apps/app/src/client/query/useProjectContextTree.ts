import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { getProjectContextTree } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { contextRequestOptionsForScheme, useContextWorkId } from "./useContextWorkId";

export function projectContextTreeQueryOptions(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  workId: string | null,
) {
  return queryOptions({
    queryKey: projectQueryKeys.contextTree(projectId, scheme, workId),
    queryFn: () =>
      getProjectContextTree(projectId, scheme, contextRequestOptionsForScheme(scheme, workId)),
    staleTime: 30_000,
  });
}

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
  options?: { enabled?: boolean; activeThreadId?: string | null; workId?: string | null },
): {
  tree: ProjectContextTreeDirectory | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const threadWorkId = useContextWorkId(projectId, options?.activeThreadId ?? null);
  const workId = options?.workId !== undefined ? options.workId : threadWorkId;
  const workScoped = isWorkScopedProjectContextScheme(scheme);
  const enabled = (options?.enabled ?? true) && (!workScoped || workId !== null);
  const { data, isError, isFetching, refetch } = useQuery({
    ...projectContextTreeQueryOptions(projectId, scheme, workId),
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
