/** Work-feed access to the project-scoped chat user-state authority. */
import type { QueryClient } from "@tanstack/react-query";

import { createProjectChatFeedCacheController, type HomeStateField } from "./home-chat-feed-cache";

export type { WorkFeedData as WorkChatFeedData } from "./home-chat-feed-cache";

export function createWorkChatFeedCacheCommand(
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: HomeStateField,
  value: boolean,
) {
  return createProjectChatFeedCacheController(client, projectId).command(threadId, field, value);
}
