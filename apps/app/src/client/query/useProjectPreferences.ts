// @ts-nocheck
/**
 * useProjectPreferences — React Query hooks for per-project sidebar
 * preferences.
 *
 * Purpose: keep server-owned thread grouping and pins in the query cache,
 * distinct from ephemeral search/filter state that lives in sidebar component
 * state. Mutations optimistically patch the project preferences cache so group
 * changes and pin toggles feel immediate, then reconcile from the server.
 */

import {
  DEFAULT_PROJECT_PREFERENCES,
  type ProjectPreferences,
  type UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getProjectPreferences, updateProjectPreferences } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";

import { projectQueryKeys } from "./project-query-keys";

type UseProjectPreferencesResult = {
  preferences: ProjectPreferences;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

export function useProjectPreferences(projectId: string): UseProjectPreferencesResult {
  const isPendingCreation = useIsProjectPendingCreation(projectId);
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: projectQueryKeys.preferences(projectId),
    queryFn: () => getProjectPreferences(projectId),
    staleTime: 30_000,
    enabled: !isPendingCreation,
  });

  return {
    preferences: data ?? DEFAULT_PROJECT_PREFERENCES,
    isError,
    isFetching,
    refetch,
  };
}

export function useUpdateProjectPreferences(projectId: string) {
  const queryClient = useQueryClient();
  const queryKey = projectQueryKeys.preferences(projectId);

  return useMutation({
    mutationFn: (patch: UpdateProjectPreferencesRequest) =>
      updateProjectPreferences(projectId, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey });

      const previous = queryClient.getQueryData<ProjectPreferences>(queryKey);
      queryClient.setQueryData<ProjectPreferences>(queryKey, {
        ...(previous ?? DEFAULT_PROJECT_PREFERENCES),
        ...patch,
      });

      return { previous };
    },
    onError: (_error, _patch, context) => {
      queryClient.setQueryData<ProjectPreferences>(
        queryKey,
        context?.previous ?? DEFAULT_PROJECT_PREFERENCES,
      );
    },
    onSuccess: (preferences) => {
      queryClient.setQueryData<ProjectPreferences>(queryKey, preferences);
    },
  });
}
