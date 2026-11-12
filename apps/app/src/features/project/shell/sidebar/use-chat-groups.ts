import { useEffect, useMemo } from "react";
import { usePinnedChatIds } from "@/client/query/thread-user-state-commands";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { groupChats } from "./chat-groups";

/**
 * The project's chats grouped as every chat list shows them (`groupChats`): the scoped Work's,
 * the others', pinned first. Every pin loads, so no chat beyond the first page offers "Pin".
 */
export function useChatGroups(
  projectId: string,
  scopeWorkId: string | null,
  noWorkId: string | null,
) {
  const { threads, isError } = useProjectThreads(projectId);
  const favoriteFeed = useProjectChatFeed(projectId, true);
  const confirmedPins = useMemo(
    () => favoriteFeed.items.map((item) => item.id),
    [favoriteFeed.items],
  );
  const pinnedIds = usePinnedChatIds(projectId, confirmedPins, favoriteFeed.dataUpdatedAt);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = favoriteFeed;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const groups = useMemo(
    () => groupChats(threads ?? [], scopeWorkId ?? noWorkId, noWorkId, pinnedIds),
    [threads, scopeWorkId, noWorkId, pinnedIds],
  );
  const settled = threads !== null && !favoriteFeed.isFetching && !favoriteFeed.hasNextPage;
  return { threads, failed: isError, groups, pinnedIds, settled };
}
