import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getProjectChatFeed } from "@/client/api/projects-api";
import { useCommands } from "@/client/commands/driver-context";
import { projectChats } from "./chat-commands";
import { flattenChatFeed } from "./chat-projections";
import { projectQueryKeys } from "./project-query-keys";

export function projectChatFeedQueryOptions(
  projectId: string,
  favorite = false,
  search: string | null = null,
  workId: string | null = null,
) {
  return infiniteQueryOptions({
    queryKey: projectQueryKeys.chatFeedFilter(projectId, { favorite, search, workId }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      getProjectChatFeed(projectId, pageParam, signal, favorite, search, workId),
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
  const query = useInfiniteQuery(projectChatFeedQueryOptions(projectId, favorite, search, workId));
  const records = useCommands();
  const items = useMemo(
    () =>
      projectChats(records, flattenChatFeed(query.data)).filter(
        (item) => !favorite || item.isFavorite,
      ),
    [records, query.data, favorite],
  );
  return { ...query, items };
}
