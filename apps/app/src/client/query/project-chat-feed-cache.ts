/** Flat project feed pages; favorite intent is owned by thread-user-state-commands. */
import type { ProjectChatFeedPage, ProjectChatItem } from "@meridian/contracts/protocol";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { projectQueryKeys } from "./project-query-keys";

export type ProjectFeedData = InfiniteData<ProjectChatFeedPage>;

export function flattenProjectFeed(data: ProjectFeedData | undefined): ProjectChatItem[] {
  const seen = new Set<string>();
  return (data?.pages.flatMap((page) => page.items) ?? []).filter(
    (item) => !seen.has(item.id) && !!seen.add(item.id),
  );
}

/** Known rows can seed a just-favorited item without moving server cursor boundaries. */
export function cachedProjectChatItems(client: QueryClient, projectId: string): ProjectChatItem[] {
  return client
    .getQueriesData<ProjectFeedData>({
      queryKey: ["projects", projectId],
      predicate: (query) =>
        query.queryKey[2] === "chat-feed" || query.queryKey[2] === "work-threads",
    })
    .flatMap(([, data]) => flattenProjectFeed(data));
}

export function mergeProjectChatItems(items: ProjectChatItem[]): ProjectChatItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id),
  );
}

export function projectFeedThread(
  client: QueryClient,
  projectId: string,
  threadId: string,
  projectItem: (item: ProjectChatItem) => ProjectChatItem,
) {
  const known = cachedProjectChatItems(client, projectId).find((item) => item.id === threadId);
  const projected = known ? projectItem(known) : undefined;
  for (const [key, current] of client.getQueriesData<ProjectFeedData>({
    queryKey: projectQueryKeys.chatFeed(projectId),
  })) {
    if (!current) continue;
    const filter = key[3];
    const favorites =
      typeof filter === "object" &&
      filter !== null &&
      "favorite" in filter &&
      filter.favorite === true;
    const pages = current.pages.map((page) =>
      projectFeedPage(page, (item) => (item.id === threadId ? projectItem(item) : item)),
    );
    if (
      favorites &&
      projected?.isFavorite &&
      pages[0] &&
      !flattenProjectFeed(current).some((item) => item.id === threadId)
    ) {
      pages[0] = { ...pages[0], items: mergeProjectChatItems([...pages[0].items, projected]) };
    }
    client.setQueryData(key, { ...current, pages });
  }
}

export function projectFeedPage(
  page: ProjectChatFeedPage,
  projectItem: (item: ProjectChatItem) => ProjectChatItem,
): ProjectChatFeedPage {
  return { ...page, items: page.items.map(projectItem) };
}
