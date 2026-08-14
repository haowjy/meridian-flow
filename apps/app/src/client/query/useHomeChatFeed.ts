/** Infinite Home feed plus field-scoped optimistic user-state commands. */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { getProjectHomeFeed } from "@/client/api/projects-api";
import {
  createHomeFeedCacheController,
  groupHomeFeed,
  type HomeStateField,
} from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import {
  getThreadUserStateTransportState,
  getThreadUserStateTransportVersion,
  runThreadUserStateCommand,
  subscribeThreadUserStateTransport,
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
  const transportVersion = useSyncExternalStore(
    (listener) => subscribeThreadUserStateTransport(client, listener),
    () => getThreadUserStateTransportVersion(client),
    () => 0,
  );
  const [manualErrors, setManualErrors] = useState<Record<string, Error | null>>({});
  const commandGeneration = useRef(new Map<string, number>());
  const runCommand = useCallback(
    async (
      threadId: string,
      field: HomeStateField,
      value: boolean,
      lifecycle?: ThreadUserStateLifecycle,
    ) => {
      const id = `${threadId}:${field}`;
      const generation = (commandGeneration.current.get(id) ?? 0) + 1;
      commandGeneration.current.set(id, generation);
      setManualErrors((current) => ({ ...current, [id]: null }));
      const outcome = await runThreadUserStateCommand(
        client,
        projectId,
        threadId,
        field,
        value,
        lifecycle,
      );
      if (commandGeneration.current.get(id) === generation) {
        setManualErrors((current) => ({
          ...current,
          [id]: outcome.status === "error" ? outcome.error : null,
        }));
      }
      return outcome.status === "success";
    },
    [client, projectId],
  );
  const getCommandState = useCallback(
    (threadId: string, field: HomeStateField) => ({
      pending: getThreadUserStateTransportState(client, projectId, threadId, field).pending,
      error: manualErrors[`${threadId}:${field}`] ?? null,
    }),
    [client, manualErrors, projectId, transportVersion],
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
