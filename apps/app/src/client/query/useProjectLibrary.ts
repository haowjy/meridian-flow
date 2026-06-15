/**
 * useProjectLibrary — full capability inventory for the Library screen.
 *
 * Backed by `GET /api/projects/:projectId/library`. Returns
 * {@link ProjectLibraryResponse} with explicit loading/error semantics;
 * a 404 from the server is normalized to an empty inventory in the API layer.
 */

import type { ProjectLibraryResponse } from "@meridian/contracts/agents";
import { useQuery } from "@tanstack/react-query";

import { getProjectLibrary } from "@/client/api/project-library-api";

import { projectQueryKeys } from "./project-query-keys";

export type ProjectLibraryStatus = {
  library: ProjectLibraryResponse | null;
  status: "loading" | "ready" | "error";
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

export function useProjectLibrary(projectId: string): ProjectLibraryStatus {
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: projectQueryKeys.library(projectId),
    queryFn: () => getProjectLibrary(projectId),
    staleTime: 60_000,
  });

  const status: ProjectLibraryStatus["status"] = isError
    ? "error"
    : data === undefined
      ? "loading"
      : "ready";

  return {
    library: data ?? null,
    status,
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
