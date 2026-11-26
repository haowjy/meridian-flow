import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "./project-query-keys";

export function upsertProjectInList(client: QueryClient, project: Project): void {
  client.setQueryData<Project[] | null>(projectQueryKeys.list, (prev) => {
    const list = prev ?? [];
    if (list.some((p) => p.id === project.id)) {
      return list.map((entry) => (entry.id === project.id ? project : entry));
    }
    return [project, ...list];
  });
}
