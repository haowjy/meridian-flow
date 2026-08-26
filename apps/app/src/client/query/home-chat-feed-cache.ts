/** Home-feed projection and the QueryClient-scoped desired-state machine. */
import type {
  HomeChatFeedPage,
  ProjectChatItem,
  UpdateThreadUserStateResponse,
  WorkChatFeedPage,
} from "@meridian/contracts/protocol";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

export type HomeFeedData = InfiniteData<HomeChatFeedPage, string | null>;
export type WorkFeedData = InfiniteData<WorkChatFeedPage, string | null>;
export type HomeStateField = "isFavorite" | "isUnread";
type Overlay = { revision: number; retireAfter?: number; value: boolean };
type ProjectState = {
  revision: number;
  watermark: number;
  requests: Set<number>;
  overlays: Map<string, Partial<Record<HomeStateField, Overlay>>>;
  fieldRevisions: Map<string, Partial<Record<HomeStateField, number>>>;
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
    value = {
      revision: 0,
      watermark: 0,
      requests: new Set(),
      overlays: new Map(),
      fieldRevisions: new Map(),
    };
    projects.set(projectId, value);
  }
  return value;
}

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

function patchItem(
  item: ProjectChatItem,
  fields: Partial<Record<HomeStateField, Overlay>>,
): ProjectChatItem {
  const desiredUnread = fields.isUnread?.value;
  return {
    ...item,
    isFavorite: fields.isFavorite?.value ?? item.isFavorite,
    // Manual read state never claims that a server-owned question was answered.
    attention:
      desiredUnread === undefined || item.attention === "actionRequired"
        ? item.attention
        : desiredUnread
          ? "unread"
          : "none",
  };
}

function mapItems(
  data: HomeFeedData,
  map: (item: ProjectChatItem) => ProjectChatItem,
): HomeFeedData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      featured: page.featured
        ? {
            continueChat: page.featured.continueChat ? map(page.featured.continueChat) : null,
            favoriteChats: page.featured.favoriteChats.map(map),
          }
        : null,
      recentChats: { ...page.recentChats, items: page.recentChats.items.map(map) },
    })),
  };
}

function mapWorkItems(
  data: WorkFeedData,
  map: (item: ProjectChatItem) => ProjectChatItem,
): WorkFeedData {
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, items: page.items.map(map) })),
  };
}

function eligibleFields(
  fields: Partial<Record<HomeStateField, Overlay>>,
  requestWatermark: number,
) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, overlay]) =>
      overlay?.retireAfter === undefined ? true : requestWatermark <= overlay.retireAfter,
    ),
  );
}

function project(
  data: HomeFeedData,
  overlays: ProjectState["overlays"],
  requestWatermark = Number.NEGATIVE_INFINITY,
): HomeFeedData {
  const pages = mapItems(data, (item) => {
    const fields = overlays.get(item.id) ?? {};
    return patchItem(item, eligibleFields(fields, requestWatermark));
  }).pages;
  const grouped = groupHomeFeed({ ...data, pages });
  if (!pages[0]) return { ...data, pages };
  pages[0] = {
    ...pages[0],
    featured: pages[0].featured
      ? {
          continueChat: grouped.continueChat,
          favoriteChats: [...grouped.favorites, ...grouped.recent]
            .filter((x) => x.isFavorite)
            .sort(compareHomeChats),
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

export function createProjectChatFeedCacheController(client: QueryClient, projectId: string) {
  const s = state(client, projectId);
  const key = ["projects", projectId, "home-feed"] as const;
  const workPrefix = ["projects", projectId, "work-threads"] as const;
  const apply = () =>
    client.setQueryData<HomeFeedData>(key, (old) => (old ? project(old, s.overlays) : old));
  const projectWork = (
    data: WorkFeedData,
    requestWatermark = Number.NEGATIVE_INFINITY,
  ): WorkFeedData =>
    mapWorkItems(data, (item) =>
      patchItem(item, eligibleFields(s.overlays.get(item.id) ?? {}, requestWatermark)),
    );
  const applyWork = () =>
    client.setQueriesData<WorkFeedData>({ queryKey: workPrefix }, (old) =>
      old ? projectWork(old) : old,
    );
  const responseField = (
    entry: ProjectChatItem,
    threadId: string,
    field: HomeStateField,
    revision: number,
    response: UpdateThreadUserStateResponse,
  ): ProjectChatItem => {
    const latest = s.fieldRevisions.get(threadId) ?? {};
    return {
      ...entry,
      isFavorite:
        field === "isFavorite" || (latest.isFavorite ?? 0) <= revision
          ? response.isFavorite
          : entry.isFavorite,
      attention:
        field === "isUnread" || (latest.isUnread ?? 0) <= revision
          ? response.attention
          : entry.attention,
    };
  };
  const reconcile = (
    threadId: string,
    field: HomeStateField,
    revision: number,
    response: UpdateThreadUserStateResponse,
  ) =>
    client.setQueryData<HomeFeedData>(key, (old) =>
      old
        ? project(
            mapItems(old, (entry) =>
              entry.id === threadId
                ? responseField(entry, threadId, field, revision, response)
                : entry,
            ),
            s.overlays,
          )
        : old,
    );
  const reconcileWork = (
    threadId: string,
    field: HomeStateField,
    revision: number,
    response: UpdateThreadUserStateResponse,
  ) =>
    client.setQueriesData<WorkFeedData>({ queryKey: workPrefix }, (old) =>
      old
        ? projectWork(
            mapWorkItems(old, (entry) =>
              entry.id === threadId
                ? responseField(entry, threadId, field, revision, response)
                : entry,
            ),
          )
        : old,
    );
  const retire = () => {
    for (const [id, fields] of s.overlays) {
      for (const field of ["isFavorite", "isUnread"] as const) {
        const overlay = fields[field];
        const retireAfter = overlay?.retireAfter;
        if (retireAfter !== undefined && ![...s.requests].some((x) => x <= retireAfter))
          delete fields[field];
      }
      if (!fields.isFavorite && !fields.isUnread) s.overlays.delete(id);
    }
  };
  return {
    reconcile,
    beginRequest() {
      const watermark = ++s.watermark;
      s.requests.add(watermark);
      return watermark;
    },
    merge(page: HomeChatFeedPage, watermark: number) {
      // A request begun after acknowledgement is authoritative for that field.
      return project({ pages: [page], pageParams: [null] }, s.overlays, watermark).pages[0] ?? page;
    },
    mergeWork(page: WorkChatFeedPage, watermark: number) {
      return projectWork({ pages: [page], pageParams: [null] }, watermark).pages[0] ?? page;
    },
    settleRequest(watermark: number) {
      s.requests.delete(watermark);
      retire();
    },
    command(threadId: string, field: HomeStateField, value: boolean) {
      const fields = s.overlays.get(threadId) ?? {};
      const revision = ++s.revision;
      const revisions = s.fieldRevisions.get(threadId) ?? {};
      revisions[field] = revision;
      s.fieldRevisions.set(threadId, revisions);
      const current = groupHomeFeed(client.getQueryData<HomeFeedData>(key));
      const item =
        [current.continueChat, ...current.favorites, ...current.recent].find(
          (candidate) => candidate?.id === threadId,
        ) ??
        client
          .getQueriesData<WorkFeedData>({ queryKey: workPrefix })
          .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? [])
          .find((candidate) => candidate.id === threadId);
      const previous =
        field === "isFavorite" ? (item?.isFavorite ?? false) : item?.attention === "unread";
      fields[field] = { revision, value };
      s.overlays.set(threadId, fields);
      apply();
      applyWork();
      return {
        succeed(response: UpdateThreadUserStateResponse) {
          if (fields[field]?.revision !== revision) return false;
          fields[field] = { revision, value, retireAfter: ++s.watermark };
          // Apply the authoritative response after the overlay becomes acknowledged so
          // fields outside this command (favorite during read, attention during favorite)
          // cannot be replaced by the optimistic pre-request cache value.
          reconcile(threadId, field, revision, response);
          reconcileWork(threadId, field, revision, response);
          retire();
          return true;
        },
        fail() {
          if (fields[field]?.revision !== revision) return false;
          // Protect the rollback from older requests, but allow later truth through.
          fields[field] = { revision, value: previous, retireAfter: ++s.watermark };
          apply();
          applyWork();
          retire();
          return true;
        },
      };
    },
  };
}
