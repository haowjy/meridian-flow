/**
 * project-list-cache — direct read/write helpers for the cached project list in
 * the React Query client (read list, optimistic upsert). Keeps cache mutation
 * logic in one place; used by optimistic create/reconcile paths.
 */

import type { Project } from "@meridian/contracts/projects";
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "./project-query-keys";

export function readProjectList(client: QueryClient): Project[] | null {
  return client.getQueryData<Project[] | null>(projectQueryKeys.list) ?? null;
}

export function upsertProjectInList(client: QueryClient, project: Project): void {
  client.setQueryData<Project[] | null>(projectQueryKeys.list, (prev) => {
    const list = prev ?? [];
    if (list.some((p) => p.id === project.id)) return list;
    return [project, ...list];
  });
}

export function patchProjectInList(client: QueryClient, id: string, patch: Partial<Project>): void {
  client.setQueryData<Project[] | null>(projectQueryKeys.list, (prev) => {
    if (!prev) return prev;
    return prev.map((p) => (p.id === id ? { ...p, ...patch } : p));
  });
}

export function removeProjectFromList(client: QueryClient, id: string): void {
  client.setQueryData<Project[] | null>(projectQueryKeys.list, (prev) =>
    prev ? prev.filter((p) => p.id !== id) : prev,
  );
}

export function restoreProjectToList(client: QueryClient, project: Project): void {
  client.setQueryData<Project[] | null>(projectQueryKeys.list, (prev) => {
    const list = prev ?? [];
    if (list.some((p) => p.id === project.id)) return list;
    return [project, ...list];
  });
}
