/** Infinite Project feed plus field-scoped optimistic user-state commands. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import {
  infiniteQueryOptions,
  type QueryClient,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

import { getProjectChatFeed } from "@/client/api/projects-api";
import {
  cachedProjectChatItems,
  flattenProjectFeed,
  mergeProjectChatItems,
  projectFeedPage,
} from "./project-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import {
  admitThreadUserStateItems,
  beginThreadUserStateFeedRequest,
  getThreadUserStateRecord,
  projectThreadUserState,
} from "./thread-user-state-commands";
import { useProjectChatCommands } from "./useProjectChatCommands";

declare const chatFeedNextPageIdentity: unique symbol;
export type ProjectFeedNextPageIdentity = string & {
  readonly [chatFeedNextPageIdentity]: true;
};

export function projectChatFeedQueryOptions(
  client: QueryClient,
  projectId: string,
  favorite = false,
  search: string | null = null,
) {
  return infiniteQueryOptions({
    queryKey: [...projectQueryKeys.chatFeed(projectId), { favorite, search }],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const requestGeneration = beginThreadUserStateFeedRequest(client, projectId);
      const page = await getProjectChatFeed(projectId, pageParam, signal, favorite, search);
      admitThreadUserStateItems(client, projectId, page.items, requestGeneration);
      const projectItem = (item: ProjectChatItem) =>
        projectThreadUserState(item, getThreadUserStateRecord(client, projectId, item));
      const projected = projectFeedPage(page, projectItem);
      // A searched page is exactly the server's matches: no membership to protect.
      if (!favorite || search || pageParam !== null) return projected;
      // A request started before a Favorite command cannot erase that command's membership.
      const changedFavorites = cachedProjectChatItems(client, projectId)
        .filter((item) => {
          const record = getThreadUserStateRecord(client, projectId, item);
          return (
            (record.favorite || (record.barrier ?? -1) >= requestGeneration) &&
            projectItem(item).isFavorite
          );
        })
        .map(projectItem);
      return {
        ...projected,
        items: mergeProjectChatItems([...projected.items, ...changedFavorites]),
      };
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
}

export function useProjectChatFeed(
  projectId: string,
  favorite = false,
  search: string | null = null,
) {
  const client = useQueryClient();
  const commands = useProjectChatCommands(projectId);
  const query = useInfiniteQuery(projectChatFeedQueryOptions(client, projectId, favorite, search));
  const nextCursor = query.data?.pages.at(-1)?.nextCursor ?? null;
  const nextPageIdentity = useMemo(
    () =>
      nextCursor === null
        ? null
        : (JSON.stringify([
            projectQueryKeys.chatFeed(projectId),
            favorite,
            search,
            nextCursor,
          ]) as ProjectFeedNextPageIdentity),
    [nextCursor, projectId, favorite, search],
  );
  return {
    ...query,
    nextPageIdentity,
    items: flattenProjectFeed(query.data).filter((item) => !favorite || item.isFavorite),
    ...commands,
  };
}
