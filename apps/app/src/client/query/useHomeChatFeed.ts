/** Infinite Home feed plus field-scoped optimistic user-state commands. */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { getProjectHomeFeed } from "@/client/api/projects-api";
import { createHomeFeedCacheController, groupHomeFeed } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import { useProjectChatCommands } from "./useProjectChatCommands";

declare const homeFeedNextPageIdentity: unique symbol;
export type HomeFeedNextPageIdentity = string & {
  readonly [homeFeedNextPageIdentity]: true;
};

export function useHomeChatFeed(projectId: string) {
  const client = useQueryClient();
  const commands = useProjectChatCommands(projectId);
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
        const page = await getProjectHomeFeed(projectId, pageParam, signal);
        return controller.merge(page, watermark);
      } finally {
        controller.settleRequest(watermark);
      }
    },
    getNextPageParam: (page) => page.recentChats.nextCursor ?? undefined,
    retry: false,
  });
  const nextCursor = query.data?.pages.at(-1)?.recentChats.nextCursor ?? null;
  const nextPageIdentity = useMemo(
    () =>
      nextCursor === null
        ? null
        : (JSON.stringify([
            projectQueryKeys.homeFeed(projectId),
            nextCursor,
          ]) as HomeFeedNextPageIdentity),
    [nextCursor, projectId],
  );
  return {
    ...query,
    nextPageIdentity,
    grouped: groupHomeFeed(query.data as import("./home-chat-feed-cache").HomeFeedData | undefined),
    ...commands,
  };
}
