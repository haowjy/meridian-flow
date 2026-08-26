/** Infinite, identity-guarded query for chats historically associated with one Work. */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";

import { listWorkThreads } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";
import { createProjectChatFeedCacheController } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import { useProjectChatCommands } from "./useProjectChatCommands";

declare const workChatsNextPageIdentity: unique symbol;
export type WorkChatsNextPageIdentity = string & {
  readonly [workChatsNextPageIdentity]: true;
};

export function useWorkThreads(projectId: string, workId: string, options?: { enabled?: boolean }) {
  const isPendingCreation = useIsProjectPendingCreation(projectId);
  const enabled = (options?.enabled ?? true) && !isPendingCreation;
  const commands = useProjectChatCommands(projectId);
  const client = useQueryClient();
  const controller = useMemo(
    () => createProjectChatFeedCacheController(client, projectId),
    [client, projectId],
  );
  const query = useInfiniteQuery({
    queryKey: projectQueryKeys.workThreads(projectId, workId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const watermark = controller.beginRequest();
      try {
        return controller.mergeWork(
          await listWorkThreads(workId, { cursor: pageParam, signal }),
          watermark,
        );
      } finally {
        controller.settleRequest(watermark);
      }
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    retry: false,
    enabled,
  });
  const threads = useMemo(() => {
    if (!query.data) return null;
    const seen = new Set<string>();
    return query.data.pages.flatMap((page) =>
      page.items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }),
    );
  }, [query.data]);
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
    ...commands,
  };
}
