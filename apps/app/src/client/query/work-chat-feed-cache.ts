/** Cache projection for Work chat pages affected by shared user-state commands. */
import type {
  ProjectChatItem,
  UpdateThreadUserStateResponse,
  WorkChatFeedPage,
} from "@meridian/contracts/protocol";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

export type WorkChatFeedData = InfiniteData<WorkChatFeedPage, string | null>;

function mapThread(
  data: WorkChatFeedData,
  threadId: string,
  map: (item: ProjectChatItem) => ProjectChatItem,
): WorkChatFeedData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === threadId ? map(item) : item)),
    })),
  };
}

export function createWorkChatFeedCacheCommand(
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: "isFavorite" | "isUnread",
  value: boolean,
) {
  const prefix = ["projects", projectId, "work-threads"] as const;
  const snapshots = client.getQueriesData<WorkChatFeedData>({ queryKey: prefix });
  client.setQueriesData<WorkChatFeedData>({ queryKey: prefix }, (old) =>
    old
      ? mapThread(old, threadId, (item) => ({
          ...item,
          isFavorite: field === "isFavorite" ? value : item.isFavorite,
          attention:
            field === "isUnread" && item.attention !== "actionRequired"
              ? value
                ? "unread"
                : "none"
              : item.attention,
        }))
      : old,
  );
  return {
    succeed(response: UpdateThreadUserStateResponse) {
      client.setQueriesData<WorkChatFeedData>({ queryKey: prefix }, (old) =>
        old
          ? mapThread(old, threadId, (item) => ({
              ...item,
              isFavorite: response.isFavorite,
              attention: response.attention,
            }))
          : old,
      );
    },
    fail() {
      for (const [key, snapshot] of snapshots) client.setQueryData(key, snapshot);
    },
  };
}
