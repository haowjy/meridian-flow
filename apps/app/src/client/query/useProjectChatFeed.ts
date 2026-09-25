/** Infinite, filtered project chat feed with favorite state projected onto its rows. */
import {
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

import { getProjectChatFeed } from "@/client/api/projects-api";
import { flattenChatFeed, projectChatFeedPage } from "./chat-projections";
import { projectQueryKeys } from "./project-query-keys";
import {
  admitThreadUserStateItems,
  beginThreadUserStateFeedRequest,
  getThreadUserStateRecord,
  projectThreadUserState,
} from "./thread-user-state-commands";

export function projectChatFeedQueryOptions(
  client: QueryClient,
  projectId: string,
  favorite = false,
  search: string | null = null,
) {
  return infiniteQueryOptions({
    queryKey: projectQueryKeys.chatFeedFilter(projectId, { favorite, search }),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const requestGeneration = beginThreadUserStateFeedRequest(client, projectId);
      const page = await getProjectChatFeed(projectId, pageParam, signal, favorite, search);
      admitThreadUserStateItems(client, projectId, page.items, requestGeneration);
      return projectChatFeedPage(page, (item) =>
        projectThreadUserState(item, getThreadUserStateRecord(client, projectId, item)),
      );
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Keep the previous filter/search results on screen while the next
    // settles, so switching Favorites or a settled search term never drops
    // back to the skeleton after the first real load.
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useProjectChatFeed(
  projectId: string,
  favorite = false,
  search: string | null = null,
) {
  const client = useQueryClient();
  const query = useInfiniteQuery(projectChatFeedQueryOptions(client, projectId, favorite, search));
  // Stable across renders that don't change `query.data`, so a keystroke
  // elsewhere in the tree does not invalidate every row's memo.
  const items = useMemo(
    // An unfavorited row leaves Favorites at once, before the refetch confirms.
    () => flattenChatFeed(query.data).filter((item) => !favorite || item.isFavorite),
    [query.data, favorite],
  );
  return { ...query, items };
}
