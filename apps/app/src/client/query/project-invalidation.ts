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
    invalidateProjectChatFeed(client, projectId),
  ]);
}

/**
 * A write-mode switch changed (queued, cancelled or withdrawn): the list rows carry its pending
 * mode and the Works read its default. The chat feed waits for the switch turn.
 */
export async function invalidateWriteModeReads(
  client: QueryClient,
  projectId: string,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) }),
    client.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) }),
  ]);
}

export function invalidateProjectChatFeed(client: QueryClient, projectId: string): Promise<void> {
  return client.invalidateQueries({
    queryKey: projectQueryKeys.chatFeed(projectId),
  });
}

/** Invalidates chats associated with one Work, or every Work in the project. */
export function invalidateWorkThreads(
  client: QueryClient,
  projectId: string,
  workId?: string,
): Promise<void> {
  return client.invalidateQueries({
    queryKey: workId
      ? projectQueryKeys.chatFeedFilter(projectId, { workId })
      : projectQueryKeys.chatFeed(projectId),
    exact: workId !== undefined,
  });
}
