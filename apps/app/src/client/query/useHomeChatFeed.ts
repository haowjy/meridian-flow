/** Infinite Home feed plus field-scoped optimistic user-state commands. */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import { getProjectHomeFeed } from "@/client/api/projects-api";
import { updateThreadUserState } from "@/client/api/threads-api";
import {
  createHomeFeedCacheController,
  groupHomeFeed,
  type HomeStateField,
} from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";

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
  });
  const inFlight = useRef(new Set<string>());
  const [commandState, setCommandState] = useState<
    Record<string, { pending: boolean; error: Error | null }>
  >({});
  const runCommand = useCallback(
    async (threadId: string, field: HomeStateField, value: boolean) => {
      const id = `${threadId}:${field}`;
      if (inFlight.current.has(id)) return false;
      inFlight.current.add(id);
      setCommandState((old) => ({ ...old, [id]: { pending: true, error: null } }));
      const command = controller.command(threadId, field, value);
      try {
        const response = await updateThreadUserState(
          threadId,
          field === "isFavorite" ? { isFavorite: value } : { isUnread: value },
        );
        command.succeed(response);
        setCommandState((old) => ({ ...old, [id]: { pending: false, error: null } }));
        return true;
      } catch (cause) {
        command.fail();
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setCommandState((old) => ({ ...old, [id]: { pending: false, error } }));
        return false;
      } finally {
        inFlight.current.delete(id);
      }
    },
    [controller],
  );
  const getCommandState = useCallback(
    (threadId: string, field: HomeStateField) =>
      commandState[`${threadId}:${field}`] ?? { pending: false, error: null },
    [commandState],
  );
  return {
    ...query,
    grouped: groupHomeFeed(query.data as import("./home-chat-feed-cache").HomeFeedData | undefined),
    setFavorite: (threadId: string, value: boolean) => runCommand(threadId, "isFavorite", value),
    setUnread: (threadId: string, value: boolean) => runCommand(threadId, "isUnread", value),
    getCommandState,
  };
}
