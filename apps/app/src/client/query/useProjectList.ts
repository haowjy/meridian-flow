/**
 * useProjectList — React Query hook for the account project library, merged
 * with optimistic project state.
 *
 * Exposes loading/empty/ready/error status and the single project-list read
 * path across the shell.
 */

import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listProjects } from "@/client/api/projects-api";
import { mergeApiProjects } from "@/client/stores";

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
  const detail = useQuery<Project | null>({
    queryKey: projectQueryKeys.detail(projectId),
    queryFn: async () => null,
    enabled: false,
  });
  return projects?.find((project) => project.id === projectId) ?? detail.data ?? undefined;
}
