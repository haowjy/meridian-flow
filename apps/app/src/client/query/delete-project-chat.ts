/** Delete a project chat and drop it from every cached chat projection. */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { deleteThread } from "@/client/api/threads-api";
import type { ChatFeedData } from "./project-chat-feed-cache";
import { invalidateProjectThreadData, invalidateWorkThreads } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";

/**
 * The server's owned soft delete, then the chat leaves every project chat
 * projection (thread list, chat feed, Work feeds) before the refetch confirms.
 */
export async function deleteProjectChat(
  client: QueryClient,
  projectId: string,
  threadId: string,
): Promise<void> {
  await deleteThread({ data: { threadId } });
  client.setQueryData<ThreadListItem[] | null>(projectQueryKeys.threads(projectId), (list) =>
    list ? list.filter((thread) => thread.id !== threadId) : list,
  );
  const withoutChat = (data: ChatFeedData | undefined) =>
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.filter((item) => item.id !== threadId),
      })),
    };
  client.setQueriesData<ChatFeedData>(
    { queryKey: projectQueryKeys.chatFeed(projectId) },
    withoutChat,
  );
  client.setQueriesData<ChatFeedData>(
    { queryKey: projectQueryKeys.workThreads(projectId) },
    withoutChat,
  );
  void invalidateProjectThreadData(client, projectId);
  void invalidateWorkThreads(client, projectId);
}
