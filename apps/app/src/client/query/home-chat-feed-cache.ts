/** Home-only category projection over immutable server feed pages. */
import type { HomeChatFeedPage, ProjectChatItem } from "@meridian/contracts/protocol";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { projectQueryKeys } from "./project-query-keys";

export type HomeFeedData = InfiniteData<HomeChatFeedPage, string | null>;

export function compareHomeChats(a: ProjectChatItem, b: ProjectChatItem): number {
  return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id);
}

export function groupHomeFeed(data: HomeFeedData | undefined) {
  const first = data?.pages[0];
  const seen = new Set<string>();
  const take = (items: ProjectChatItem[]) =>
    items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
  const continueChat = first?.featured?.continueChat ?? null;
  if (continueChat) seen.add(continueChat.id);
  const favorites = take(first?.featured?.favoriteChats ?? []).sort(compareHomeChats);
  const recent = take(data?.pages.flatMap((page) => page.recentChats.items) ?? []).sort(
    compareHomeChats,
  );
  return { continueChat, favorites, recent };
}

function mapThread(
  data: HomeFeedData,
  threadId: string,
  projectItem: (item: ProjectChatItem) => ProjectChatItem,
): HomeFeedData {
  let changed = false;
  const map = (item: ProjectChatItem) => {
    if (item.id !== threadId) return item;
    changed = true;
    return projectItem(item);
  };
  const pages = data.pages.map((page) => ({
    ...page,
    featured: page.featured
      ? {
          continueChat: page.featured.continueChat ? map(page.featured.continueChat) : null,
          favoriteChats: page.featured.favoriteChats.map(map),
        }
      : null,
    recentChats: { ...page.recentChats, items: page.recentChats.items.map(map) },
  }));
  return changed ? { ...data, pages } : data;
}

function regroupHomeFeed(data: HomeFeedData): HomeFeedData {
  const grouped = groupHomeFeed(data);
  const pages = [...data.pages];
  if (!pages[0]) return data;
  pages[0] = {
    ...pages[0],
    featured: pages[0].featured
      ? {
          continueChat: grouped.continueChat,
          favoriteChats: [...grouped.favorites, ...grouped.recent]
            .filter((item) => item.isFavorite)
            .sort(compareHomeChats),
        }
      : null,
  };
  const recent = [...grouped.favorites, ...grouped.recent].filter((item) => !item.isFavorite);
  pages.forEach((page, index) => {
    const count = page.recentChats.items.length;
    pages[index] = {
      ...page,
      recentChats: { ...page.recentChats, items: recent.splice(0, count) },
    };
  });
  if (recent.length) {
    const lastIndex = pages.length - 1;
    const last = pages[lastIndex];
    if (last)
      pages[lastIndex] = {
        ...last,
        recentChats: { ...last.recentChats, items: [...last.recentChats.items, ...recent] },
      };
  }
  return { ...data, pages };
}

export function projectHomeThread(
  client: QueryClient,
  projectId: string,
  threadId: string,
  projectItem: (item: ProjectChatItem) => ProjectChatItem,
) {
  client.setQueryData<HomeFeedData>(projectQueryKeys.homeFeed(projectId), (current) => {
    if (!current) return current;
    const mapped = mapThread(current, threadId, projectItem);
    return mapped === current ? current : regroupHomeFeed(mapped);
  });
}

export function projectHomePage(
  page: HomeChatFeedPage,
  projectItem: (item: ProjectChatItem) => ProjectChatItem,
): HomeChatFeedPage {
  const data = regroupHomeFeed({
    pages: [
      {
        ...page,
        featured: page.featured
          ? {
              continueChat: page.featured.continueChat
                ? projectItem(page.featured.continueChat)
                : null,
              favoriteChats: page.featured.favoriteChats.map(projectItem),
            }
          : null,
        recentChats: { ...page.recentChats, items: page.recentChats.items.map(projectItem) },
      },
    ],
    pageParams: [null],
  });
  return data.pages[0] ?? page;
}
