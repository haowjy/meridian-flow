// @ts-nocheck
/**
 * useProjectList — React Query hook for the sidebar project list, merged with
 * optimistic and independent-project state and with soft-delete suppressions.
 *
 * Exposes the loading/empty/ready/error list status plus the visible-project
 * derivation. The single read path for the project list across the shell.
 */

import type { Project } from "@meridian/contracts/projects";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listProjects } from "@/client/api/projects-api";
import {
  getSuppressedProjectListIds,
  mergeApiProjects,
  useIndependentProjectIds,
} from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";

function useProjectListQuery() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: projectQueryKeys.list,
    queryFn: async () => {
      const apiProjects = await listProjects();
      const prev = queryClient.getQueryData<Project[] | null>(projectQueryKeys.list);
      return mergeApiProjects(prev ?? null, apiProjects, {
        excludeIds: getSuppressedProjectListIds(),
      });
    },
    staleTime: 60_000,
  });
}

export type ProjectListStatus = {
  projects: Project[] | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

/**
 * Sidebar/home project list. `null` = not loaded yet; `[]` = loaded and empty.
 * Seeded from the authenticated route loader via the shared query provider.
 */
export function useProjectListStatus(): ProjectListStatus {
  const { data, isError, isFetching, refetch } = unwrapListQuery(useProjectListQuery());

  return { projects: data, isError, isFetching, refetch };
}

export function useProjectList(): Project[] | null {
  return useProjectListStatus().projects;
}

export function useProject(projectId: string): Project | undefined {
  const projects = useProjectList();
  return projects?.find((p) => p.id === projectId);
}

/**
 * Project list for *display* surfaces (home recents, sidebar, drawer) —
 * excludes un-promoted independent chats, which are project-backed but hidden
 * until the user promotes them. Use `useProjectList` (unfiltered) when you need
 * to resolve a specific project by id, including hidden ones.
 */
export function useVisibleProjects(): Project[] | null {
  const projects = useProjectList();
  const independentIds = useIndependentProjectIds();
  if (projects === null) return null;
  if (independentIds.size === 0) return projects;
  return projects.filter((p) => !independentIds.has(p.id));
}
