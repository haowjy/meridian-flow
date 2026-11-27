import { useEffect, useMemo } from "react";
import { useCommands } from "@/client/commands/driver-context";
import { projectPinnedChats } from "@/client/query/chat-commands";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { groupChats } from "./chat-groups";

export function useChatGroups(
  projectId: string,
  scopeWorkId: string | null,
  noWorkId: string | null,
) {
  const { threads, isError } = useProjectThreads(projectId);
  const favoriteFeed = useProjectChatFeed(projectId, true);
  const records = useCommands();
  const pinnedIds = useMemo(
    () =>
      projectPinnedChats(
        records,
        favoriteFeed.items.map((item) => item.id),
      ),
    [records, favoriteFeed.items],
  );
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
