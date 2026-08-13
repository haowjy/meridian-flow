/** Pure Home-feed projection and QueryClient-owned optimistic state controller. */
import type { HomeChatFeedPage, HomeChatItem } from "@meridian/contracts/protocol";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

export type HomeFeedData = InfiniteData<HomeChatFeedPage, string | null>;
type Field = "isFavorite" | "isUnread";
type Overlay = { revision: number; acknowledgedAt?: number; value: boolean };
type ProjectState = {
  revision: number;
  watermark: number;
  requests: Set<number>;
  overlays: Map<string, Partial<Record<Field, Overlay>>>;
};

const states = new WeakMap<QueryClient, Map<string, ProjectState>>();
function state(client: QueryClient, projectId: string): ProjectState {
  let projects = states.get(client);
  if (!projects) {
    projects = new Map();
    states.set(client, projects);
  }
  let value = projects.get(projectId);
  if (!value) {
    value = { revision: 0, watermark: 0, requests: new Set(), overlays: new Map() };
    projects.set(projectId, value);
  }
  return value;
}

export function compareHomeChats(a: HomeChatItem, b: HomeChatItem): number {
  return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id);
}

export function groupHomeFeed(data: HomeFeedData | undefined) {
  const first = data?.pages[0];
  const seen = new Set<string>();
  const take = (items: HomeChatItem[]) =>
    items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
  const continueChat = first?.featured?.continueChat ?? null;
  if (continueChat) seen.add(continueChat.id);
  const favorites = take(first?.featured?.favoriteChats ?? []).sort(compareHomeChats);
  const recent = take(data?.pages.flatMap((page) => page.recentChats.items) ?? []).sort(
    compareHomeChats,
  );
  return { continueChat, favorites, recent };
}

function patchItem(item: HomeChatItem, fields: Partial<Record<Field, Overlay>>): HomeChatItem {
  return {
    ...item,
    isFavorite: fields.isFavorite?.value ?? item.isFavorite,
    attention: fields.isUnread ? (fields.isUnread.value ? "unread" : "none") : item.attention,
  };
}

function project(data: HomeFeedData, overlays: ProjectState["overlays"]): HomeFeedData {
  const patch = (item: HomeChatItem) => patchItem(item, overlays.get(item.id) ?? {});
  const pages = data.pages.map((page) => ({
    ...page,
    featured: page.featured
      ? {
          continueChat: page.featured.continueChat ? patch(page.featured.continueChat) : null,
          favoriteChats: page.featured.favoriteChats.map(patch),
        }
      : null,
    recentChats: { ...page.recentChats, items: page.recentChats.items.map(patch) },
  }));
  // Category membership is derived once, then written back without losing page boundaries.
  const grouped = groupHomeFeed({ ...data, pages });
  if (!pages[0]) return { ...data, pages };
  pages[0] = {
    ...pages[0],
    featured: pages[0].featured
      ? {
          continueChat: grouped.continueChat,
          favoriteChats: [
            ...grouped.favorites.filter((x) => x.isFavorite),
            ...grouped.recent.filter((x) => x.isFavorite),
          ].sort(compareHomeChats),
        }
      : null,
  };
  const recent = [...grouped.favorites, ...grouped.recent].filter((x) => !x.isFavorite);
  pages.forEach((page, index) => {
    const count = page.recentChats.items.length;
    pages[index] = {
      ...page,
      recentChats: { ...page.recentChats, items: recent.splice(0, count) },
    };
  });
  if (recent.length) pages.at(-1)?.recentChats.items.push(...recent);
  return { ...data, pages };
}

export function createHomeFeedCacheController(client: QueryClient, projectId: string) {
  const s = state(client, projectId);
  const key = ["projects", projectId, "home-feed"] as const;
  const apply = () =>
    client.setQueryData<HomeFeedData>(key, (old) => (old ? project(old, s.overlays) : old));
  return {
    beginRequest() {
      const watermark = ++s.watermark;
      s.requests.add(watermark);
      return watermark;
    },
    merge(page: HomeChatFeedPage, watermark: number) {
      const patched = project({ pages: [page], pageParams: [null] }, s.overlays).pages[0] ?? page;
      s.requests.delete(watermark);
      for (const [id, fields] of s.overlays) {
        for (const field of ["isFavorite", "isUnread"] as const) {
          const overlay = fields[field];
          const acknowledgedAt = overlay?.acknowledgedAt;
          if (
            acknowledgedAt &&
            ![...s.requests].some((x) => x < acknowledgedAt) &&
            watermark > acknowledgedAt
          )
            delete fields[field];
        }
        if (!fields.isFavorite && !fields.isUnread) s.overlays.delete(id);
      }
      return patched;
    },
    settleRequest(watermark: number) {
      s.requests.delete(watermark);
    },
    command(threadId: string, field: Field, value: boolean) {
      const fields = s.overlays.get(threadId) ?? {};
      const revision = ++s.revision;
      const current = groupHomeFeed(client.getQueryData<HomeFeedData>(key));
      const item = [current.continueChat, ...current.favorites, ...current.recent].find(
        (candidate) => candidate?.id === threadId,
      );
      const previous =
        field === "isFavorite" ? (item?.isFavorite ?? false) : item?.attention !== "none";
      fields[field] = { revision, value };
      s.overlays.set(threadId, fields);
      apply();
      return {
        succeed: () => {
          if (fields[field]?.revision !== revision) return;
          fields[field] = { revision, value, acknowledgedAt: ++s.watermark };
          apply();
        },
        fail: () => {
          if (fields[field]?.revision !== revision) return;
          fields[field] = { revision, value: previous };
          apply();
        },
      };
    },
  };
}
