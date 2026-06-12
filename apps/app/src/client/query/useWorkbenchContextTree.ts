// @ts-nocheck

import type {
  WorkbenchContextTreeDirectory,
  WorkbenchContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getWorkbenchContextTree } from "@/client/api/workbenches-api";

import { workbenchQueryKeys } from "./workbench-query-keys";

/**
 * Workbench context tree for the given scheme (`kb`, `work`, `user`, or `fs1`). Files
 * include the persisted `documents.id`; the editor must use that id, not the
 * display path.
 *
 * The scheme is required and threaded into both the query key and the API
 * call — distinct schemes back distinct trees and must cache independently.
 */
export function useWorkbenchContextTree(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme,
  options?: { enabled?: boolean },
): {
  tree: WorkbenchContextTreeDirectory | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const enabled = options?.enabled ?? true;
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: workbenchQueryKeys.contextTree(workbenchId, scheme),
    queryFn: () => getWorkbenchContextTree(workbenchId, scheme),
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
