/**
 * Delete-a-chat command: the server's owned soft delete, then the chat leaves
 * every project chat projection (thread list, project feed, Work feeds).
 * Confirmation state lives here so every list that offers Delete shares it.
 */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { deleteThread } from "@/client/api/threads-api";
import type { ProjectFeedData } from "./project-chat-feed-cache";
import { invalidateProjectThreadData, invalidateWorkThreads } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";

export type DeleteChatTarget = { id: string; title: string };

export function useDeleteChat(projectId: string, onDeleted?: (threadId: string) => void) {
  const client = useQueryClient();
  const [target, setTarget] = useState<DeleteChatTarget | null>(null);
  const mutation = useMutation({
    mutationFn: (threadId: string) => deleteThread({ data: { threadId } }),
    onSuccess: (_result, threadId) => {
      removeChatFromProjectCaches(client, projectId, threadId);
      onDeleted?.(threadId);
      setTarget(null);
      void invalidateProjectThreadData(client, projectId);
      void invalidateWorkThreads(client, projectId);
    },
  });
  return {
    target,
    isPending: mutation.isPending,
    error: mutation.error,
    request: (next: DeleteChatTarget) => {
      mutation.reset();
      setTarget(next);
    },
    cancel: () => {
      if (mutation.isPending) return;
      mutation.reset();
      setTarget(null);
    },
    confirm: () => {
      if (target) mutation.mutate(target.id);
    },
  };
}

function removeChatFromProjectCaches(client: QueryClient, projectId: string, threadId: string) {
  client.setQueryData<ThreadListItem[] | null>(projectQueryKeys.threads(projectId), (list) =>
    list ? list.filter((thread) => thread.id !== threadId) : list,
  );
  const withoutChat = (data: ProjectFeedData | undefined) =>
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.filter((item) => item.id !== threadId),
      })),
    };
  client.setQueriesData<ProjectFeedData>(
    { queryKey: projectQueryKeys.chatFeed(projectId) },
    withoutChat,
  );
  client.setQueriesData<ProjectFeedData>(
    { queryKey: projectQueryKeys.workThreads(projectId) },
    withoutChat,
  );
}
