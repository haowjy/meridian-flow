/** QueryClient-scoped normalized authority for project-thread user state and transport. */
import type { ProjectChatItem, UpdateThreadUserStateResponse } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { updateThreadUserState } from "@/client/api/threads-api";
import { groupHomeFeed, type HomeFeedData, projectHomeThread } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";

export type ThreadUserStateField = "isFavorite" | "isUnread";
export type ThreadUserStateOutcome =
  | { status: "success"; response: UpdateThreadUserStateResponse }
  | { status: "error"; error: Error };
export type ThreadUserStateLifecycle = { beforeRollback?: () => void };
export type ThreadUserStateCommandView = {
  pending: boolean;
  desiredValue?: boolean;
  error?: Error;
};

type BaseState = Pick<ProjectChatItem, "isFavorite" | "attention">;
type PendingField = { revision: number; desiredValue: boolean; projectedValue: boolean };
export type ThreadUserStateRecord = {
  base: BaseState;
  admittedAt: Record<ThreadUserStateField, number>;
  barriers?: Partial<Record<ThreadUserStateField, number>>;
  commands?: Partial<Record<ThreadUserStateField, PendingField>>;
  errors?: Partial<Record<ThreadUserStateField, Error>>;
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
  admittedAt: { isFavorite: -1, isUnread: -1 },
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

function fieldValue(record: ThreadUserStateRecord, field: ThreadUserStateField) {
  const desired = record.commands?.[field]?.projectedValue;
  if (desired !== undefined) return desired;
  return field === "isFavorite" ? record.base.isFavorite : record.base.attention === "unread";
}

export function projectThreadUserState(
  item: ProjectChatItem,
  record: ThreadUserStateRecord,
): ProjectChatItem {
  const desiredUnread = record.commands?.isUnread?.projectedValue;
  return {
    ...item,
    isFavorite: fieldValue(record, "isFavorite"),
    attention:
      desiredUnread === undefined || record.base.attention === "actionRequired"
        ? record.base.attention
        : desiredUnread
          ? "unread"
          : "none",
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
        if (
          requestGeneration >= (current.barriers?.isFavorite ?? -1) &&
          requestGeneration >= current.admittedAt.isFavorite
        ) {
          base = { ...base, isFavorite: item.isFavorite };
          admittedAt = { ...admittedAt, isFavorite: requestGeneration };
        }
        if (
          requestGeneration >= (current.barriers?.isUnread ?? -1) &&
          requestGeneration >= current.admittedAt.isUnread
        ) {
          base = { ...base, attention: item.attention };
          admittedAt = { ...admittedAt, isUnread: requestGeneration };
        }
        return base === current.base ? current : { ...current, base, admittedAt };
      },
      item,
    );
  }
}

export function getThreadUserStateCommandView(
  record: ThreadUserStateRecord,
  field: ThreadUserStateField,
): ThreadUserStateCommandView {
  const command = record.commands?.[field];
  return command
    ? { pending: true, desiredValue: command.desiredValue, error: record.errors?.[field] }
    : { pending: false, error: record.errors?.[field] };
}

function syncHome(client: QueryClient, projectId: string, threadId: string) {
  const record = readRecord(client, projectId, threadId);
  projectHomeThread(client, projectId, threadId, (item) => projectThreadUserState(item, record));
}

export function runThreadUserStateCommand(
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: ThreadUserStateField,
  value: boolean,
  lifecycle: ThreadUserStateLifecycle = {},
): Promise<ThreadUserStateOutcome> {
  const owner = authority(client, projectId);
  const id = `${threadId}:${field}`;
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
  writeRecord(client, projectId, threadId, (current) => {
    const pending = current.commands?.[field];
    const commands = {
      ...current.commands,
      [field]: {
        revision,
        desiredValue: value,
        projectedValue: pending?.projectedValue ?? value,
      },
    };
    const errors = { ...current.errors };
    delete errors[field];
    return {
      ...current,
      commands,
      errors: Object.keys(errors).length ? errors : undefined,
    };
  });
  syncHome(client, projectId, threadId);
  if (!queue.running) void advance(owner, id, client, projectId, threadId, field);
  return promise;
}

async function advance(
  owner: ProjectAuthority,
  id: string,
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: ThreadUserStateField,
): Promise<void> {
  const queue = owner.queues.get(id);
  const entry = queue?.entries[0];
  if (!queue || !entry || queue.running) return;
  queue.running = true;
  writeRecord(client, projectId, threadId, (current) => {
    const pending = current.commands?.[field];
    if (!pending || pending.projectedValue === entry.value) return current;
    return {
      ...current,
      commands: { ...current.commands, [field]: { ...pending, projectedValue: entry.value } },
    };
  });
  syncHome(client, projectId, threadId);
  let outcome: ThreadUserStateOutcome;
  try {
    const response = await updateThreadUserState(
      threadId,
      field === "isFavorite" ? { isFavorite: entry.value } : { isUnread: entry.value },
    );
    const barrier = ++owner.generation;
    writeRecord(client, projectId, threadId, (current) => {
      const base =
        field === "isFavorite"
          ? { ...current.base, isFavorite: response.isFavorite }
          : { ...current.base, attention: response.attention };
      const commands = { ...current.commands };
      if (commands[field]?.revision === entry.revision) delete commands[field];
      const errors = { ...current.errors };
      delete errors[field];
      return {
        ...current,
        base,
        barriers: { ...current.barriers, [field]: barrier },
        commands: Object.keys(commands).length ? commands : undefined,
        errors: Object.keys(errors).length ? errors : undefined,
      };
    });
    outcome = { status: "success", response };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    entry.lifecycles.forEach((item) => {
      item.beforeRollback?.();
    });
    writeRecord(client, projectId, threadId, (current) => {
      const commands = { ...current.commands };
      const isLatest = commands[field]?.revision === entry.revision;
      if (isLatest) delete commands[field];
      return {
        ...current,
        commands: Object.keys(commands).length ? commands : undefined,
        errors: isLatest ? { ...current.errors, [field]: error } : current.errors,
      };
    });
    outcome = { status: "error", error };
  }

  syncHome(client, projectId, threadId);
  queue.entries.shift();
  queue.running = false;
  const next = queue.entries[0];
  if (!next) owner.queues.delete(id);
  entry.resolve(outcome);
  if (next) void advance(owner, id, client, projectId, threadId, field);
}
