/** Infinite, identity-guarded query for chats historically associated with one Work. */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";

import { listWorkThreads } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";
import { flattenChatFeed } from "./chat-projections";
import { projectQueryKeys } from "./project-query-keys";
import {
  admitThreadUserStateItems,
  beginThreadUserStateFeedRequest,
} from "./thread-user-state-commands";

declare const workChatsNextPageIdentity: unique symbol;
export type WorkChatsNextPageIdentity = string & {
  readonly [workChatsNextPageIdentity]: true;
};

export function useWorkThreads(projectId: string, workId: string, options?: { enabled?: boolean }) {
  const isPendingCreation = useIsProjectPendingCreation(projectId);
  const enabled = (options?.enabled ?? true) && !isPendingCreation;
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: projectQueryKeys.workThreads(projectId, workId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const requestGeneration = beginThreadUserStateFeedRequest(client, projectId);
      const page = await listWorkThreads(workId, { cursor: pageParam, signal });
      admitThreadUserStateItems(client, projectId, page.items, requestGeneration);
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    retry: false,
    enabled,
  });
  const threads = useMemo(() => (query.data ? flattenChatFeed(query.data) : null), [query.data]);
  const nextCursor = query.data?.pages.at(-1)?.nextCursor ?? null;
  const nextPageIdentity = useMemo(
    () =>
      nextCursor === null
        ? null
        : (JSON.stringify([
            projectQueryKeys.workThreads(projectId, workId),
            nextCursor,
          ]) as WorkChatsNextPageIdentity),
    [nextCursor, projectId, workId],
  );
  const currentIdentity = useRef(nextPageIdentity);
  currentIdentity.current = nextPageIdentity;
  const fetchNextPageFor = useCallback(
    (identity: WorkChatsNextPageIdentity) => {
      if (identity !== currentIdentity.current || query.isFetchingNextPage) return;
      void query.fetchNextPage();
    },
    [query.fetchNextPage, query.isFetchingNextPage],
  );
  return {
    ...query,
    threads,
    nextPageIdentity,
    fetchNextPageFor,
  };
}
