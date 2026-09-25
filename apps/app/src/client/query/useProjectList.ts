/**
 * useProjectList — React Query hook for the account project library, merged with
 * optimistic and independent-project state.
 *
 * Exposes the loading/empty/ready/error list status plus the visible-project
 * derivation. The single read path for the project list across the shell.
 */

import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listProjects } from "@/client/api/projects-api";
import { mergeApiProjects, useIndependentProjectIds } from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";

function useProjectListQuery() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: projectQueryKeys.list,
    queryFn: async () => {
      const apiProjects = await listProjects();
      const prev = queryClient.getQueryData<Project[] | null>(projectQueryKeys.list);
      const pendingTitles = new Map(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: projectQueryKeys.renamePrefix })
          .filter((mutation) => mutation.state.status === "pending")
          .flatMap((mutation) => {
            const projectId = mutation.options.mutationKey?.[2];
            const title = mutation.state.variables;
            return typeof projectId === "string" && typeof title === "string"
              ? [[projectId, title] as const]
              : [];
          }),
      );
      const reconciled = apiProjects.map((project) => {
        const title = pendingTitles.get(project.id);
        return title ? { ...project, title, name: title } : project;
      });
      return mergeApiProjects(prev ?? null, reconciled);
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
 * Account project list. `null` = not loaded yet; `[]` = loaded and empty.
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
 * Project list for *display* surfaces (account library) —
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
