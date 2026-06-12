// @ts-nocheck
/**
 * useWorkbenchPreferences — React Query hooks for per-workbench sidebar
 * preferences.
 *
 * Purpose: keep server-owned thread grouping and pins in the query cache,
 * distinct from ephemeral search/filter state that lives in sidebar component
 * state. Mutations optimistically patch the workbench preferences cache so group
 * changes and pin toggles feel immediate, then reconcile from the server.
 */

import {
  DEFAULT_WORKBENCH_PREFERENCES,
  type UpdateWorkbenchPreferencesRequest,
  type WorkbenchPreferences,
} from "@meridian/contracts/preferences";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getWorkbenchPreferences, updateWorkbenchPreferences } from "@/client/api/workbenches-api";
import { useIsWorkbenchPendingCreation } from "@/client/stores";

import { workbenchQueryKeys } from "./workbench-query-keys";

type UseProjectPreferencesResult = {
  preferences: WorkbenchPreferences;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

export function useWorkbenchPreferences(workbenchId: string): UseProjectPreferencesResult {
  const isPendingCreation = useIsWorkbenchPendingCreation(workbenchId);
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: workbenchQueryKeys.preferences(workbenchId),
    queryFn: () => getWorkbenchPreferences(workbenchId),
    staleTime: 30_000,
    enabled: !isPendingCreation,
  });

  return {
    preferences: data ?? DEFAULT_WORKBENCH_PREFERENCES,
    isError,
    isFetching,
    refetch,
  };
}

export function useUpdateWorkbenchPreferences(workbenchId: string) {
  const queryClient = useQueryClient();
  const queryKey = workbenchQueryKeys.preferences(workbenchId);

  return useMutation({
    mutationFn: (patch: UpdateWorkbenchPreferencesRequest) =>
      updateWorkbenchPreferences(workbenchId, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey });

      const previous = queryClient.getQueryData<WorkbenchPreferences>(queryKey);
      queryClient.setQueryData<WorkbenchPreferences>(queryKey, {
        ...(previous ?? DEFAULT_WORKBENCH_PREFERENCES),
        ...patch,
      });

      return { previous };
    },
    onError: (_error, _patch, context) => {
      queryClient.setQueryData<WorkbenchPreferences>(
        queryKey,
        context?.previous ?? DEFAULT_WORKBENCH_PREFERENCES,
      );
    },
    onSuccess: (preferences) => {
      queryClient.setQueryData<WorkbenchPreferences>(queryKey, preferences);
    },
  });
}
