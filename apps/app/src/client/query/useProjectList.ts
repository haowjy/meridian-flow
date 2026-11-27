import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { getProject, listProjects } from "@/client/api/projects-api";
import { useCommands } from "@/client/commands/driver-context";
import { unwrapListQuery } from "./list-query";
import { projectProjectTitles } from "./project-commands";
import { projectQueryKeys } from "./project-query-keys";

function mergeApiProjects(prev: Project[] | null, apiProjects: Project[]): Project[] {
  const apiIds = new Set(apiProjects.map((project) => project.id));
  const optimisticOnly = (prev ?? []).filter((project) => !apiIds.has(project.id));
  return [...optimisticOnly, ...apiProjects];
}

function useProjectListQuery() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: projectQueryKeys.list,
    queryFn: async () => {
      const apiProjects = await listProjects();
      const prev = queryClient.getQueryData<Project[] | null>(projectQueryKeys.list);
      return mergeApiProjects(prev ?? null, apiProjects);
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

export function useProjectListStatus(): ProjectListStatus {
  const { data, isError, isFetching, refetch } = unwrapListQuery(useProjectListQuery());
  const records = useCommands();
  const projects = useMemo(() => data && projectProjectTitles(records, data), [records, data]);
  return { projects, isError, isFetching, refetch };
}

export function useProjectList(): Project[] | null {
  return useProjectListStatus().projects;
}

export function useProject(
  projectId: string,
  initialProject?: Project | null,
): Project | undefined {
  const listProject = useProjectListQuery().data?.find((project) => project.id === projectId);
  const detail = useQuery<Project>({
    queryKey: projectQueryKeys.detail(projectId),
    queryFn: () => getProject(projectId),
    initialData: initialProject ?? listProject,
    staleTime: 30_000,
  });
  const records = useCommands();
  const project = listProject ?? detail.data ?? initialProject ?? undefined;
  return useMemo(() => project && projectProjectTitles(records, [project])[0], [records, project]);
}
