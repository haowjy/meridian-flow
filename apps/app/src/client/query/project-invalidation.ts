/**
 * project-invalidation — canonical convergence for project-level thread
 * projections. Query keys live in `project-query-keys`.
 */
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "./project-query-keys";

export async function invalidateProjectThreadData(
  client: QueryClient,
  projectId: string,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) }),
    client.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) }),
    invalidateProjectHomeFeed(client, projectId),
  ]);
}

export function invalidateProjectHomeFeed(client: QueryClient, projectId: string): Promise<void> {
  return client.invalidateQueries({
    queryKey: projectQueryKeys.homeFeed(projectId),
    exact: true,
  });
}

/** Invalidates chats associated with one Work, or every Work in the project. */
export function invalidateWorkThreads(
  client: QueryClient,
  projectId: string,
  workId?: string,
): Promise<void> {
  return client.invalidateQueries({
    queryKey: projectQueryKeys.workThreads(projectId, workId),
    exact: workId !== undefined,
  });
}
