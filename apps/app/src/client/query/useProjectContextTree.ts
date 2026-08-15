import type { ContextSchemeCapabilities } from "@meridian/contracts/context-uri";
import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { getProjectContextTree } from "@/client/api/projects-api";
import { contextRequestOptionsForScheme } from "./context-request-options";
import { projectQueryKeys } from "./project-query-keys";

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
 * Project context tree for the given scheme (`manuscript`, `kb`, `user`,
 * `scratch`, or `uploads`).
 * include the persisted `documents.id`; the editor must use that id, not the
 * display path.
 *
 * The scheme is required and threaded into both the query key and the API
 * call — distinct schemes back distinct trees and must cache independently.
 * Work-scoped schemes (`scratch`, `uploads`) also key and query by `workId`.
 */
export function useProjectContextTree(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options: { enabled?: boolean; workId: string | null },
): {
  tree: ProjectContextTreeDirectory | null;
  capabilities: ContextSchemeCapabilities | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const workId = options.workId;
  const workScoped = isWorkScopedProjectContextScheme(scheme);
  const enabled = (options.enabled ?? true) && (!workScoped || workId !== null);
  const { data, isError, isFetching, refetch } = useQuery({
    ...projectContextTreeQueryOptions(projectId, scheme, workId),
    enabled,
  });

  return {
    tree: data?.tree ?? null,
    capabilities: data?.capabilities ?? null,
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
