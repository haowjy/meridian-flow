/** Infinite Home feed plus field-scoped optimistic user-state commands. */
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { getProjectHomeFeed } from "@/client/api/projects-api";
import { updateThreadUserState } from "@/client/api/threads-api";
import { createHomeFeedCacheController, groupHomeFeed } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";

export function useHomeChatFeed(projectId: string) {
  const client = useQueryClient();
  const controller = useMemo(
    () => createHomeFeedCacheController(client, projectId),
    [client, projectId],
  );
  const query = useInfiniteQuery({
    queryKey: projectQueryKeys.homeFeed(projectId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const watermark = controller.beginRequest();
      try {
        const page = await getProjectHomeFeed(projectId, pageParam);
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        return controller.merge(page, watermark);
      } finally {
        controller.settleRequest(watermark);
      }
    },
    getNextPageParam: (page) => page.recentChats.nextCursor ?? undefined,
  });
  const state = useMutation({
    mutationFn: ({
      threadId,
      field,
      value,
    }: {
      threadId: string;
      field: "isFavorite" | "isUnread";
      value: boolean;
    }) => {
      const command = controller.command(threadId, field, value);
      return updateThreadUserState(
        threadId,
        field === "isFavorite" ? { isFavorite: value } : { isUnread: value },
      )
        .then((response) => {
          command.succeed();
          return response;
        })
        .catch((error) => {
          command.fail();
          throw error;
        });
    },
  });
  return {
    ...query,
    grouped: groupHomeFeed(query.data as import("./home-chat-feed-cache").HomeFeedData | undefined),
    setFavorite: (threadId: string, value: boolean) =>
      state.mutate({ threadId, field: "isFavorite", value }),
    setUnread: (threadId: string, value: boolean) =>
      state.mutate({ threadId, field: "isUnread", value }),
  };
}
