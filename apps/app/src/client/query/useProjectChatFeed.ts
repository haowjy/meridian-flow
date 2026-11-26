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
  workId: string | null = null,
) {
  return infiniteQueryOptions({
    queryKey: projectQueryKeys.chatFeedFilter(projectId, { favorite, search, workId }),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const requestGeneration = beginThreadUserStateFeedRequest(client, projectId);
      const page = await getProjectChatFeed(projectId, pageParam, signal, favorite, search, workId);
      admitThreadUserStateItems(client, projectId, page.items, requestGeneration);
      return projectChatFeedPage(page, (item) =>
        projectThreadUserState(item, getThreadUserStateRecord(client, projectId, item)),
      );
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useProjectChatFeed(
  projectId: string,
  favorite = false,
  search: string | null = null,
  workId: string | null = null,
) {
  const client = useQueryClient();
  const query = useInfiniteQuery(
    projectChatFeedQueryOptions(client, projectId, favorite, search, workId),
  );
  const items = useMemo(
    () => flattenChatFeed(query.data).filter((item) => !favorite || item.isFavorite),
    [query.data, favorite],
  );
  return { ...query, items };
}
