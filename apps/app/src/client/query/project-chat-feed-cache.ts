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

/** Applies a thread's projection to every cached chat-feed page in place. */
export function projectFeedThread(
  client: QueryClient,
  projectId: string,
  threadId: string,
  projectItem: (item: ProjectChatItem) => ProjectChatItem,
) {
  client.setQueriesData<ProjectFeedData>(
    { queryKey: projectQueryKeys.chatFeed(projectId) },
    (current) =>
      current && {
        ...current,
        pages: current.pages.map((page) =>
          projectFeedPage(page, (item) => (item.id === threadId ? projectItem(item) : item)),
        ),
      },
  );
}

export function projectFeedPage(
  page: ProjectChatFeedPage,
  projectItem: (item: ProjectChatItem) => ProjectChatItem,
): ProjectChatFeedPage {
  return { ...page, items: page.items.map(projectItem) };
}
