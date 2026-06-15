import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getProjectContextTree } from "@/client/api/projects-api";

import { projectQueryKeys } from "./project-query-keys";

/**
 * Project context tree for the given scheme (`kb`, `work`, `user`, or `fs1`). Files
 * include the persisted `documents.id`; the editor must use that id, not the
 * display path.
 *
 * The scheme is required and threaded into both the query key and the API
 * call — distinct schemes back distinct trees and must cache independently.
 */
export function useProjectContextTree(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options?: { enabled?: boolean },
): {
  tree: ProjectContextTreeDirectory | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const enabled = options?.enabled ?? true;
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: projectQueryKeys.contextTree(projectId, scheme),
    queryFn: () => getProjectContextTree(projectId, scheme),
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
