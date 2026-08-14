/** QueryClient-scoped authority for optimistic thread user-state commands. */
import type { UpdateThreadUserStateResponse } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { updateThreadUserState } from "@/client/api/threads-api";
import { createHomeFeedCacheController, type HomeStateField } from "./home-chat-feed-cache";

export type ThreadUserStateOutcome =
  | { status: "success"; response: UpdateThreadUserStateResponse }
  | { status: "error"; error: Error };
export type ThreadUserStateTransportState =
  | { pending: false; desiredValue?: never }
  | { pending: true; desiredValue: boolean };
export type ThreadUserStateLifecycle = { beforeRollback?: () => void };

type QueuedCommand = {
  value: boolean;
  promise: Promise<ThreadUserStateOutcome>;
  resolve: (outcome: ThreadUserStateOutcome) => void;
  lifecycles: Set<ThreadUserStateLifecycle>;
};
type CommandQueue = { running: boolean; entries: QueuedCommand[] };
type Authority = {
  version: number;
  active: Map<string, CommandQueue>;
  states: Map<string, ThreadUserStateTransportState>;
  listeners: Set<() => void>;
};
const authorities = new WeakMap<QueryClient, Authority>();
const idleState: ThreadUserStateTransportState = { pending: false };

function authority(client: QueryClient): Authority {
  let current = authorities.get(client);
  if (!current) {
    current = { version: 0, active: new Map(), states: new Map(), listeners: new Set() };
    authorities.set(client, current);
  }
  return current;
}
const commandId = (projectId: string, threadId: string, field: HomeStateField) =>
  `${projectId}:${threadId}:${field}`;
function publish(owner: Authority, id: string, state: ThreadUserStateTransportState) {
  owner.states.set(id, state);
  owner.version += 1;
  owner.listeners.forEach((listener) => {
    listener();
  });
}

export function subscribeThreadUserStateTransport(client: QueryClient, listener: () => void) {
  const owner = authority(client);
  owner.listeners.add(listener);
  return () => owner.listeners.delete(listener);
}
export function getThreadUserStateTransportVersion(client: QueryClient) {
  return authority(client).version;
}

export function runThreadUserStateCommand(
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: HomeStateField,
  value: boolean,
  lifecycle: ThreadUserStateLifecycle = {},
): Promise<ThreadUserStateOutcome> {
  const owner = authority(client);
  const id = commandId(projectId, threadId, field);
  let queue = owner.active.get(id);
  if (!queue) {
    queue = { running: false, entries: [] };
    owner.active.set(id, queue);
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
  queue.entries.push({ value, promise, resolve, lifecycles: new Set([lifecycle]) });
  publish(owner, id, { pending: true, desiredValue: value });
  if (!queue.running)
    void advanceThreadUserStateQueue(owner, id, client, projectId, threadId, field);
  return promise;
}

async function advanceThreadUserStateQueue(
  owner: Authority,
  id: string,
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: HomeStateField,
): Promise<void> {
  const queue = owner.active.get(id);
  const entry = queue?.entries[0];
  if (!queue || !entry || queue.running) return;
  queue.running = true;
  const cacheCommand = createHomeFeedCacheController(client, projectId).command(
    threadId,
    field,
    entry.value,
  );
  let outcome: ThreadUserStateOutcome;
  try {
    const response = await updateThreadUserState(
      threadId,
      field === "isFavorite" ? { isFavorite: entry.value } : { isUnread: entry.value },
    );
    // Let stale query observer delivery finish before applying the mutation response.
    await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 0));
    cacheCommand.succeed(response);
    outcome = { status: "success", response };
  } catch (cause) {
    entry.lifecycles.forEach((item) => {
      item.beforeRollback?.();
    });
    cacheCommand.fail();
    outcome = {
      status: "error",
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }

  // Remove the settled entry and release the queue before resolving consumers.
  // A consumer may synchronously enqueue the opposite value without observing
  // the completed command as active.
  queue.entries.shift();
  queue.running = false;
  const next = queue.entries[0];
  if (!next) owner.active.delete(id);
  publish(owner, id, next ? { pending: true, desiredValue: next.value } : { pending: false });
  entry.resolve(outcome);
  if (next) void advanceThreadUserStateQueue(owner, id, client, projectId, threadId, field);
}

export function getThreadUserStateTransportState(
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: HomeStateField,
) {
  return authority(client).states.get(commandId(projectId, threadId, field)) ?? idleState;
}
