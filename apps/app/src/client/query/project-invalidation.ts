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

export function invalidateWorkThreads(
  client: QueryClient,
  projectId: string,
  workId: string,
): Promise<void> {
  return client.invalidateQueries({
    queryKey: projectQueryKeys.chatFeedFilter(projectId, { workId }),
    exact: true,
  });
}
