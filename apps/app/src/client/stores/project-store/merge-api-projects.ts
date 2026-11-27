import type { ProjectDto as Project } from "@meridian/contracts/projects";

export function mergeApiProjects(prev: Project[] | null, apiProjects: Project[]): Project[] {
  const apiIds = new Set(apiProjects.map((project) => project.id));
  const optimisticOnly = (prev ?? []).filter((project) => !apiIds.has(project.id));
  return [...optimisticOnly, ...apiProjects];
}
