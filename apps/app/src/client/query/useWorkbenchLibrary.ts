// @ts-nocheck
/**
 * useWorkbenchLibrary — full capability inventory for the Library screen.
 *
 * Backed by `GET /api/workbenches/:workbenchId/library`. Returns
 * {@link WorkbenchLibraryResponse} with explicit loading/error semantics;
 * a 404 from the server is normalized to an empty inventory in the API layer.
 */

import type { WorkbenchLibraryResponse } from "@meridian/contracts/agents";
import { useQuery } from "@tanstack/react-query";

import { getWorkbenchLibrary } from "@/client/api/workbench-library-api";

import { workbenchQueryKeys } from "./workbench-query-keys";

export type WorkbenchLibraryStatus = {
  library: WorkbenchLibraryResponse | null;
  status: "loading" | "ready" | "error";
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

export function useWorkbenchLibrary(workbenchId: string): WorkbenchLibraryStatus {
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: workbenchQueryKeys.library(workbenchId),
    queryFn: () => getWorkbenchLibrary(workbenchId),
    staleTime: 60_000,
  });

  const status: WorkbenchLibraryStatus["status"] = isError
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
