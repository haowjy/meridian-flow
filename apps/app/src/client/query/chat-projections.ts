import type {
  ProjectChatFeedPage,
  ProjectChatItem,
  ThreadListItem,
} from "@meridian/contracts/protocol";
import { type InfiniteData, notifyManager, type QueryClient } from "@tanstack/react-query";
import { projectQueryKeys } from "./project-query-keys";

export type ChatFeedData = InfiniteData<ProjectChatFeedPage>;

export function flattenChatFeed(data: ChatFeedData | undefined): ProjectChatItem[] {
  const seen = new Set<string>();
  return (data?.pages.flatMap((page) => page.items) ?? []).filter(
    (item) => !seen.has(item.id) && !!seen.add(item.id),
  );
}

export function projectChatFeedPage(
  page: ProjectChatFeedPage,
  projectItem: (item: ProjectChatItem) => ProjectChatItem,
): ProjectChatFeedPage {
  return { ...page, items: page.items.map(projectItem) };
}

export type ChatRowPatch = {
  threadListItem?: (item: ThreadListItem) => ThreadListItem | null;
  projectChatItem?: (item: ProjectChatItem) => ProjectChatItem | null;
};

function patchThreadList(
  client: QueryClient,
  projectId: string,
  threadId: string,
  update: (item: ThreadListItem) => ThreadListItem | null,
): void {
  client.setQueryData<ThreadListItem[] | null>(projectQueryKeys.threads(projectId), (list) => {
    if (!list) return list;
    let changed = false;
    const next: ThreadListItem[] = [];
    for (const item of list) {
      if (item.id !== threadId) {
        next.push(item);
        continue;
      }
      changed = true;
      const result = update(item);
      if (result) next.push(result);
    }
    return changed ? next : list;
  });
}

function patchFeedData(
  data: ChatFeedData | undefined,
  threadId: string,
  update: (item: ProjectChatItem) => ProjectChatItem | null,
): ChatFeedData | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.items.some((item) => item.id === threadId)) return page;
    changed = true;
    const items: ProjectChatItem[] = [];
    for (const item of page.items) {
      if (item.id !== threadId) {
        items.push(item);
        continue;
      }
      const result = update(item);
      if (result) items.push(result);
    }
    return { ...page, items };
  });
  return changed ? { ...data, pages } : data;
}

function patchFeedQueries(
  client: QueryClient,
  queryKeyPrefix: readonly unknown[],
  threadId: string,
  update: (item: ProjectChatItem) => ProjectChatItem | null,
): void {
  client.setQueriesData<ChatFeedData>({ queryKey: queryKeyPrefix }, (current) =>
    patchFeedData(current, threadId, update),
  );
}

export function patchChatRow(
  client: QueryClient,
  projectId: string | undefined,
  threadId: string,
  update: ChatRowPatch,
): void {
  notifyManager.batch(() => {
    if (update.threadListItem) {
      const threadListItem = update.threadListItem;
      if (projectId) {
        patchThreadList(client, projectId, threadId, threadListItem);
      } else {
        for (const query of client.getQueryCache().findAll({ queryKey: projectQueryKeys.all })) {
          const [, id, scope] = query.queryKey;
          if (scope === "threads" && typeof id === "string") {
            patchThreadList(client, id, threadId, threadListItem);
          }
        }
      }
    }
    if (update.projectChatItem) {
      const projectChatItem = update.projectChatItem;
      if (projectId) {
        patchFeedQueries(client, projectQueryKeys.chatFeed(projectId), threadId, projectChatItem);
      } else {
        for (const query of client.getQueryCache().findAll({ queryKey: projectQueryKeys.all })) {
          const [, id, scope] = query.queryKey;
          if (typeof id !== "string") continue;
          if (scope === "chat-feed") {
            client.setQueryData<ChatFeedData>(query.queryKey, (current) =>
              patchFeedData(current, threadId, projectChatItem),
            );
          }
        }
      }
    }
  });
}

export function removeChatRow(client: QueryClient, projectId: string, threadId: string): void {
  patchChatRow(client, projectId, threadId, {
    threadListItem: () => null,
    projectChatItem: () => null,
  });
}

export type ChatRowSnapshot = {
  threadList: ThreadListItem[] | null;
  feeds: { queryKey: readonly unknown[]; data: ChatFeedData }[];
};

export function snapshotChatRow(
  client: QueryClient,
  projectId: string,
  threadId: string,
): ChatRowSnapshot {
  const threadList =
    client.getQueryData<ThreadListItem[] | null>(projectQueryKeys.threads(projectId)) ?? null;
  const feeds = [
    ...client.getQueriesData<ChatFeedData>({ queryKey: projectQueryKeys.chatFeed(projectId) }),
  ]
    .filter(
      (entry): entry is [readonly unknown[], ChatFeedData] =>
        !!entry[1] &&
        entry[1].pages.some((page) => page.items.some((item) => item.id === threadId)),
    )
    .map(([queryKey, data]) => ({ queryKey, data }));
  return { threadList, feeds };
}

export function restoreChatRow(
  client: QueryClient,
  projectId: string,
  threadId: string,
  snapshot: ChatRowSnapshot,
): void {
  notifyManager.batch(() => {
    if (snapshot.threadList?.some((item) => item.id === threadId)) {
      client.setQueryData(projectQueryKeys.threads(projectId), snapshot.threadList);
    }
    for (const { queryKey, data } of snapshot.feeds) {
      client.setQueryData(queryKey, data);
    }
  });
}
