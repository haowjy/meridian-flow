// @ts-nocheck
/**
 * workbench-thread-cache — direct read/write helpers for a workbench's cached thread
 * list in the React Query client (read, optimistic upsert/replace). Keeps thread
 * cache mutation in one place; consumed by optimistic create/reconcile flows.
 *
 * The cache stores `ThreadListItem[]` so consumers see the denormalized work +
 * lifecycle (`waitingForUser`, `runningTurnId`) projection from the server.
 * Optimistic inserts produce a synthetic `ThreadListItem` from a base `Thread`
 * with default lifecycle hints (no work, no live turn, not waiting); the next
 * server fetch reconciles them.
 */

import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "./workbench-query-keys";

export function readProjectThreadList(
  client: QueryClient,
  workbenchId: string,
): ThreadListItem[] | null {
  return (
    client.getQueryData<ThreadListItem[] | null>(workbenchQueryKeys.threads(workbenchId)) ?? null
  );
}

/**
 * Lift a base `Thread` into a `ThreadListItem` shape using neutral lifecycle
 * defaults. Used for optimistic inserts before the server projection arrives.
 */
export type ThreadListLifecycle = Pick<ThreadListItem, "waitingForUser" | "runningTurnId">;

const neutralLifecycle: ThreadListLifecycle = { waitingForUser: false, runningTurnId: null };

function toListItem(
  thread: Thread,
  lifecycle: ThreadListLifecycle = neutralLifecycle,
): ThreadListItem {
  return { ...thread, work: null, ...lifecycle };
}

export function upsertThreadInProject(
  client: QueryClient,
  thread: Thread,
  lifecycle?: ThreadListLifecycle,
): void {
  client.setQueryData<ThreadListItem[] | null>(
    workbenchQueryKeys.threads(thread.workbenchId),
    (prev) => {
      const list = prev ?? [];
      if (list.some((t) => t.id === thread.id)) {
        return list.map((t) =>
          t.id === thread.id ? { ...t, ...thread, ...(lifecycle ?? {}) } : t,
        );
      }
      return [toListItem(thread, lifecycle), ...list];
    },
  );
}

export function patchThreadInProjectCaches(
  client: QueryClient,
  id: string,
  patch: Partial<ThreadListItem>,
): void {
  for (const query of client.getQueryCache().findAll({ queryKey: workbenchQueryKeys.all })) {
    const [, , scope] = query.queryKey;
    if (scope !== "threads") continue;
    client.setQueryData<ThreadListItem[] | null>(query.queryKey, (prev) => {
      if (!prev) return prev;
      return prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
    });
  }
}
