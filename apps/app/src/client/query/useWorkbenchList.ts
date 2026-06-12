// @ts-nocheck
/**
 * useWorkbenchList — React Query hook for the sidebar workbench list, merged with
 * optimistic and independent-workbench state and with soft-delete suppressions.
 *
 * Exposes the loading/empty/ready/error list status plus the visible-workbench
 * derivation. The single read path for the workbench list across the shell.
 */

import type { Workbench } from "@meridian/contracts/workbenches";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listWorkbenches } from "@/client/api/workbenches-api";
import {
  getSuppressedWorkbenchListIds,
  mergeApiWorkbenches,
  useIndependentWorkbenchIds,
} from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { workbenchQueryKeys } from "./workbench-query-keys";

function useProjectListQuery() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: workbenchQueryKeys.list,
    queryFn: async () => {
      const apiProjects = await listWorkbenches();
      const prev = queryClient.getQueryData<Workbench[] | null>(workbenchQueryKeys.list);
      return mergeApiWorkbenches(prev ?? null, apiProjects, {
        excludeIds: getSuppressedWorkbenchListIds(),
      });
    },
    staleTime: 60_000,
  });
}

export type WorkbenchListStatus = {
  workbenches: Workbench[] | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

/**
 * Sidebar/home workbench list. `null` = not loaded yet; `[]` = loaded and empty.
 * Seeded from the authenticated route loader via the shared query provider.
 */
export function useWorkbenchListStatus(): WorkbenchListStatus {
  const { data, isError, isFetching, refetch } = unwrapListQuery(useProjectListQuery());

  return { workbenches: data, isError, isFetching, refetch };
}

export function useWorkbenchList(): Workbench[] | null {
  return useWorkbenchListStatus().workbenches;
}

export function useProject(workbenchId: string): Workbench | undefined {
  const workbenches = useWorkbenchList();
  return workbenches?.find((p) => p.id === workbenchId);
}

/**
 * Workbench list for *display* surfaces (home recents, sidebar, drawer) —
 * excludes un-promoted independent chats, which are workbench-backed but hidden
 * until the user promotes them. Use `useWorkbenchList` (unfiltered) when you need
 * to resolve a specific workbench by id, including hidden ones.
 */
export function useVisibleWorkbenches(): Workbench[] | null {
  const workbenches = useWorkbenchList();
  const independentIds = useIndependentWorkbenchIds();
  if (workbenches === null) return null;
  if (independentIds.size === 0) return workbenches;
  return workbenches.filter((p) => !independentIds.has(p.id));
}
