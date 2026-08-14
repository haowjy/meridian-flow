/** QueryClient-scoped authority for optimistic thread user-state commands. */
import type { UpdateThreadUserStateResponse } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { updateThreadUserState } from "@/client/api/threads-api";
import { createHomeFeedCacheController, type HomeStateField } from "./home-chat-feed-cache";

export type ThreadUserStateOutcome =
  | { status: "success"; response: UpdateThreadUserStateResponse }
  | { status: "error"; error: Error };
export type ThreadUserStateCommandState = {
  pending: boolean;
  error: Error | null;
  outcome: ThreadUserStateOutcome | null;
};
export type ThreadUserStateLifecycle = { beforeRollback?: () => void };

type ActiveCommand = {
  value: boolean;
  promise: Promise<ThreadUserStateOutcome>;
  lifecycles: Set<ThreadUserStateLifecycle>;
};
type Authority = {
  version: number;
  active: Map<string, ActiveCommand>;
  states: Map<string, ThreadUserStateCommandState>;
  listeners: Set<() => void>;
};
const authorities = new WeakMap<QueryClient, Authority>();
const idleState: ThreadUserStateCommandState = { pending: false, error: null, outcome: null };

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
function publish(owner: Authority, id: string, state: ThreadUserStateCommandState) {
  owner.states.set(id, state);
  owner.version += 1;
  owner.listeners.forEach((listener) => {
    listener();
  });
}

export function subscribeThreadUserStateCommands(client: QueryClient, listener: () => void) {
  const owner = authority(client);
  owner.listeners.add(listener);
  return () => owner.listeners.delete(listener);
}
export function getThreadUserStateCommandVersion(client: QueryClient) {
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
  const existing = owner.active.get(id);
  if (existing) {
    if (existing.value === value) {
      existing.lifecycles.add(lifecycle);
      return existing.promise;
    }
    return existing.promise.then(() =>
      runThreadUserStateCommand(client, projectId, threadId, field, value, lifecycle),
    );
  }

  const lifecycles = new Set([lifecycle]);
  const cacheCommand = createHomeFeedCacheController(client, projectId).command(
    threadId,
    field,
    value,
  );
  publish(owner, id, { pending: true, error: null, outcome: null });
  const promise = updateThreadUserState(
    threadId,
    field === "isFavorite" ? { isFavorite: value } : { isUnread: value },
  )
    .then(
      (response) =>
        new Promise<ThreadUserStateOutcome>((resolve) => {
          // Query observers may still flush the request result that preceded this
          // command. Reconcile after that notification turn so stale local delivery
          // cannot replace the authoritative mutation response.
          setTimeout(() => {
            cacheCommand.succeed(response);
            const outcome = { status: "success" as const, response };
            publish(owner, id, { pending: false, error: null, outcome });
            resolve(outcome);
          }, 0);
        }),
    )
    .catch((cause): ThreadUserStateOutcome => {
      lifecycles.forEach((entry) => {
        entry.beforeRollback?.();
      });
      cacheCommand.fail();
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const outcome = { status: "error" as const, error };
      publish(owner, id, { pending: false, error, outcome });
      return outcome;
    })
    .finally(() => {
      // Keep the settled command joinable through consumer reconciliation renders.
      // A visible-chat acknowledgement updates its snapshot in a promise consumer;
      // deleting synchronously here would let that render start a duplicate transport.
      setTimeout(() => {
        if (owner.active.get(id)?.promise === promise) owner.active.delete(id);
      }, 0);
    });
  owner.active.set(id, { value, promise, lifecycles });
  return promise;
}

export function useThreadUserStateCommandState(
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: HomeStateField,
) {
  const owner = authority(client);
  const id = commandId(projectId, threadId, field);
  return useSyncExternalStore(
    (listener) => {
      owner.listeners.add(listener);
      return () => owner.listeners.delete(listener);
    },
    () => owner.states.get(id) ?? idleState,
    () => idleState,
  );
}

export function getThreadUserStateCommandState(
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: HomeStateField,
) {
  return authority(client).states.get(commandId(projectId, threadId, field)) ?? idleState;
}

export function clearThreadUserStateCommandOutcome(
  client: QueryClient,
  projectId: string,
  threadId: string,
  field: HomeStateField,
) {
  const owner = authority(client);
  const id = commandId(projectId, threadId, field);
  const current = owner.states.get(id);
  if (!owner.active.has(id) && current && current !== idleState) publish(owner, id, idleState);
}
