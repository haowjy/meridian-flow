/**
 * project-list-cache — direct read/write helpers for the cached project list in
 * the React Query client. Keeps cache mutation logic in one place; used by the
 * optimistic independent-creation path.
 */

import type { Project } from "@meridian/contracts/projects";
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "./project-query-keys";

export function upsertProjectInList(client: QueryClient, project: Project): void {
  client.setQueryData<Project[] | null>(projectQueryKeys.list, (prev) => {
    const list = prev ?? [];
    if (list.some((p) => p.id === project.id)) return list;
    return [project, ...list];
  });
}
