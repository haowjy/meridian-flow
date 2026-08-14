/** Infinite Home feed plus field-scoped optimistic user-state commands. */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { getProjectHomeFeed } from "@/client/api/projects-api";
import {
  createHomeFeedCacheController,
  groupHomeFeed,
  type HomeStateField,
} from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import {
  getThreadUserStateCommandState,
  getThreadUserStateCommandVersion,
  runThreadUserStateCommand,
  subscribeThreadUserStateCommands,
  type ThreadUserStateLifecycle,
} from "./thread-user-state-commands";

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
        const page = await getProjectHomeFeed(projectId, pageParam, signal);
        return controller.merge(page, watermark);
      } finally {
        controller.settleRequest(watermark);
      }
    },
    getNextPageParam: (page) => page.recentChats.nextCursor ?? undefined,
    retry: false,
  });
  // Re-render for command state owned outside this hook and shared across mounts.
  const commandVersion = useSyncExternalStore(
    (listener) => subscribeThreadUserStateCommands(client, listener),
    () => getThreadUserStateCommandVersion(client),
    () => 0,
  );
  const runCommand = useCallback(
    async (
      threadId: string,
      field: HomeStateField,
      value: boolean,
      lifecycle?: ThreadUserStateLifecycle,
    ) => {
      const outcome = await runThreadUserStateCommand(
        client,
        projectId,
        threadId,
        field,
        value,
        lifecycle,
      );
      return outcome.status === "success";
    },
    [client, projectId],
  );
  const getCommandState = useCallback(
    (threadId: string, field: HomeStateField) =>
      getThreadUserStateCommandState(client, projectId, threadId, field),
    // commandVersion is the shared authority's render invalidation signal.
    [client, projectId, commandVersion],
  );
  return {
    ...query,
    grouped: groupHomeFeed(query.data as import("./home-chat-feed-cache").HomeFeedData | undefined),
    setFavorite: (threadId: string, value: boolean, lifecycle?: ThreadUserStateLifecycle) =>
      runCommand(threadId, "isFavorite", value, lifecycle),
    setUnread: (threadId: string, value: boolean) => runCommand(threadId, "isUnread", value),
    getCommandState,
  };
}
