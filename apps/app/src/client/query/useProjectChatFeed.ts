/** Infinite, filtered project chat feed with favorite state projected onto its rows. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import {
  infiniteQueryOptions,
  type QueryClient,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { getProjectChatFeed } from "@/client/api/projects-api";
import { flattenProjectFeed, projectFeedPage } from "./project-chat-feed-cache";
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
      return projectFeedPage(page, (item) =>
        projectThreadUserState(item, getThreadUserStateRecord(client, projectId, item)),
      );
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
  const query = useInfiniteQuery(projectChatFeedQueryOptions(client, projectId, favorite, search));
  return {
    ...query,
    // An unfavorited row leaves Favorites at once, before the refetch confirms.
    items: flattenProjectFeed(query.data).filter((item) => !favorite || item.isFavorite),
  };
}
