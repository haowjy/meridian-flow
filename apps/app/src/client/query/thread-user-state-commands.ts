/** QueryClient-scoped normalized authority for Project-chat favorite and attention state. */
import type { ProjectChatItem, UpdateThreadUserStateResponse } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { updateThreadUserState } from "@/client/api/threads-api";
import { groupHomeFeed, type HomeFeedData, projectHomeThread } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";

export type ThreadUserStateOutcome =
  | { status: "success"; response: UpdateThreadUserStateResponse }
  | { status: "error"; error: Error };
export type ThreadUserStateLifecycle = { beforeRollback?: () => void };
export type ThreadUserStateCommandView = {
  pending: boolean;
  desiredValue?: boolean;
  error?: Error;
};

type StateField = "isFavorite" | "attention";
type CommandKind = "favorite" | "openAcknowledgement";
type BaseState = Pick<ProjectChatItem, StateField>;
type PendingFavorite = { revision: number; desiredValue: boolean; projectedValue: boolean };
export type ThreadUserStateRecord = {
  base: BaseState;
  admittedAt: Record<StateField, number>;
  barriers?: Partial<Record<StateField, number>>;
  favorite?: PendingFavorite;
  favoriteError?: Error;
};
type QueuedCommand = {
  revision: number;
  value: boolean;
  promise: Promise<ThreadUserStateOutcome>;
  resolve: (outcome: ThreadUserStateOutcome) => void;
  lifecycles: Set<ThreadUserStateLifecycle>;
};
type CommandQueue = { running: boolean; entries: QueuedCommand[] };
type ProjectAuthority = { generation: number; revision: number; queues: Map<string, CommandQueue> };
const authorities = new WeakMap<QueryClient, Map<string, ProjectAuthority>>();

function authority(client: QueryClient, projectId: string): ProjectAuthority {
  let projects = authorities.get(client);
  if (!projects) {
    projects = new Map();
    authorities.set(client, projects);
  }
  let current = projects.get(projectId);
  if (!current) {
    current = { generation: 0, revision: 0, queues: new Map() };
    projects.set(projectId, current);
  }
  return current;
}

const defaultRecord = (item?: ProjectChatItem): ThreadUserStateRecord => ({
  base: { isFavorite: item?.isFavorite ?? false, attention: item?.attention ?? "none" },
  admittedAt: { isFavorite: -1, attention: -1 },
});
const stateKey = (projectId: string, threadId: string) =>
  projectQueryKeys.threadUserState(projectId, threadId);

function homeItem(client: QueryClient, projectId: string, threadId: string) {
  const grouped = groupHomeFeed(
    client.getQueryData<HomeFeedData>(projectQueryKeys.homeFeed(projectId)),
  );
  return [grouped.continueChat, ...grouped.favorites, ...grouped.recent].find(
    (item) => item?.id === threadId,
  );
}

function readRecord(
  client: QueryClient,
  projectId: string,
  threadId: string,
  fallback?: ProjectChatItem,
): ThreadUserStateRecord {
  return (
    client.getQueryData<ThreadUserStateRecord>(stateKey(projectId, threadId)) ??
    defaultRecord(fallback ?? homeItem(client, projectId, threadId) ?? undefined)
  );
}

function writeRecord(
  client: QueryClient,
  projectId: string,
  threadId: string,
  update: (current: ThreadUserStateRecord) => ThreadUserStateRecord,
  fallback?: ProjectChatItem,
) {
  client.setQueryData<ThreadUserStateRecord>(stateKey(projectId, threadId), (current) =>
    update(
      current ?? defaultRecord(fallback ?? homeItem(client, projectId, threadId) ?? undefined),
    ),
  );
}

export function projectThreadUserState(
  item: ProjectChatItem,
  record: ThreadUserStateRecord,
): ProjectChatItem {
  return {
    ...item,
    isFavorite: record.favorite?.projectedValue ?? record.base.isFavorite,
    attention: record.base.attention,
  };
}

export function getThreadUserStateRecord(
  client: QueryClient,
  projectId: string,
  item: ProjectChatItem,
) {
  return readRecord(client, projectId, item.id, item);
}

export function beginThreadUserStateFeedRequest(client: QueryClient, projectId: string) {
  return ++authority(client, projectId).generation;
}

export function admitThreadUserStateItems(
  client: QueryClient,
  projectId: string,
  items: readonly ProjectChatItem[],
  requestGeneration: number,
) {
  for (const item of items) {
    writeRecord(
      client,
      projectId,
      item.id,
      (current) => {
        let base = current.base;
        let admittedAt = current.admittedAt;
        for (const field of ["isFavorite", "attention"] as const) {
          if (
            requestGeneration >= (current.barriers?.[field] ?? -1) &&
            requestGeneration >= current.admittedAt[field]
          ) {
            base = { ...base, [field]: item[field] };
            admittedAt = { ...admittedAt, [field]: requestGeneration };
          }
        }
        return base === current.base ? current : { ...current, base, admittedAt };
      },
      item,
    );
  }
}

export function getFavoriteCommandView(record: ThreadUserStateRecord): ThreadUserStateCommandView {
  return record.favorite
    ? {
        pending: true,
        desiredValue: record.favorite.desiredValue,
        error: record.favoriteError,
      }
    : { pending: false, error: record.favoriteError };
}

function syncHome(client: QueryClient, projectId: string, threadId: string) {
  const record = readRecord(client, projectId, threadId);
  projectHomeThread(client, projectId, threadId, (item) => projectThreadUserState(item, record));
}

export function runFavoriteCommand(
  client: QueryClient,
  projectId: string,
  threadId: string,
  value: boolean,
  lifecycle: ThreadUserStateLifecycle = {},
): Promise<ThreadUserStateOutcome> {
  return enqueue(client, projectId, threadId, "favorite", value, lifecycle);
}

export function acknowledgeThreadOpen(
  client: QueryClient,
  projectId: string,
  threadId: string,
): Promise<ThreadUserStateOutcome> {
  return enqueue(client, projectId, threadId, "openAcknowledgement", true, {});
}

function enqueue(
  client: QueryClient,
  projectId: string,
  threadId: string,
  kind: CommandKind,
  value: boolean,
  lifecycle: ThreadUserStateLifecycle,
): Promise<ThreadUserStateOutcome> {
  const owner = authority(client, projectId);
  const id = `${threadId}:${kind}`;
  let queue = owner.queues.get(id);
  if (!queue) {
    queue = { running: false, entries: [] };
    owner.queues.set(id, queue);
  }
  const tail = queue.entries.at(-1);
  if (tail?.value === value) {
    tail.lifecycles.add(lifecycle);
    return tail.promise;
  }

  let resolve!: (outcome: ThreadUserStateOutcome) => void;
  const promise = new Promise<ThreadUserStateOutcome>((done) => {
    resolve = done;
  });
  const revision = ++owner.revision;
  queue.entries.push({ revision, value, promise, resolve, lifecycles: new Set([lifecycle]) });
  if (kind === "favorite") {
    writeRecord(client, projectId, threadId, (current) => ({
      ...current,
      favorite: {
        revision,
        desiredValue: value,
        projectedValue: current.favorite?.projectedValue ?? value,
      },
      favoriteError: undefined,
    }));
    syncHome(client, projectId, threadId);
  }
  if (!queue.running) void advance(owner, id, client, projectId, threadId, kind);
  return promise;
}

async function advance(
  owner: ProjectAuthority,
  id: string,
  client: QueryClient,
  projectId: string,
  threadId: string,
  kind: CommandKind,
): Promise<void> {
  const queue = owner.queues.get(id);
  const entry = queue?.entries[0];
  if (!queue || !entry || queue.running) return;
  queue.running = true;
  if (kind === "favorite") {
    writeRecord(client, projectId, threadId, (current) => {
      if (!current.favorite || current.favorite.projectedValue === entry.value) return current;
      return { ...current, favorite: { ...current.favorite, projectedValue: entry.value } };
    });
    syncHome(client, projectId, threadId);
  }

  let outcome: ThreadUserStateOutcome;
  try {
    const response = await updateThreadUserState(
      threadId,
      kind === "favorite" ? { isFavorite: entry.value } : { acknowledgeOpen: true },
    );
    const field: StateField = kind === "favorite" ? "isFavorite" : "attention";
    const barrier = ++owner.generation;
    writeRecord(client, projectId, threadId, (current) => ({
      ...current,
      base: { ...current.base, [field]: response[field] },
      barriers: { ...current.barriers, [field]: barrier },
      favorite:
        kind === "favorite" && current.favorite?.revision === entry.revision
          ? undefined
          : current.favorite,
      favoriteError: kind === "favorite" ? undefined : current.favoriteError,
    }));
    outcome = { status: "success", response };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (kind === "favorite") {
      entry.lifecycles.forEach((item) => {
        item.beforeRollback?.();
      });
      writeRecord(client, projectId, threadId, (current) => {
        const isLatest = current.favorite?.revision === entry.revision;
        return {
          ...current,
          favorite: isLatest ? undefined : current.favorite,
          favoriteError: isLatest ? error : current.favoriteError,
        };
      });
    }
    outcome = { status: "error", error };
  }

  syncHome(client, projectId, threadId);
  queue.entries.shift();
  queue.running = false;
  const next = queue.entries[0];
  if (!next) owner.queues.delete(id);
  entry.resolve(outcome);
  if (next) void advance(owner, id, client, projectId, threadId, kind);
}
