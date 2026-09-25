/**
 * project-thread-cache — canonical read/write helpers for cached thread
 * projections, including optimistic project-list writes and live lifecycle
 * convergence across project lists, Project, and Work feeds.
 *
 * The cache stores `ThreadListItem[]` so consumers see the denormalized work +
 * lifecycle (`actionRequired`, `runningTurnId`) and draft-review count projection from the server.
 * Optimistic inserts produce a synthetic `ThreadListItem` from a base `Thread`
 * with default lifecycle hints (no work, no live turn, not waiting); the next
 * server fetch reconciles them.
 */

import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { patchChatRow } from "./chat-projections";
import { projectQueryKeys } from "./project-query-keys";

export function readProjectThreadList(
  client: QueryClient,
  projectId: string,
): ThreadListItem[] | null {
  return client.getQueryData<ThreadListItem[] | null>(projectQueryKeys.threads(projectId)) ?? null;
}

/**
 * Lift a base `Thread` into a `ThreadListItem` shape using neutral lifecycle
 * defaults. Used for optimistic inserts before the server projection arrives.
 */
export type ThreadListLifecycle = Pick<ThreadListItem, "actionRequired" | "runningTurnId">;

const neutralLifecycle: ThreadListLifecycle = { actionRequired: false, runningTurnId: null };

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
    projectQueryKeys.threads(thread.projectId),
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
  for (const query of client.getQueryCache().findAll({ queryKey: projectQueryKeys.all })) {
    const [, , scope] = query.queryKey;
    if (scope !== "threads") continue;
    client.setQueryData<ThreadListItem[] | null>(query.queryKey, (prev) => {
      if (!prev) return prev;
      return prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
    });
  }
}

/**
 * Project one live lifecycle change into every cached representation of a
 * thread, across every mounted project (the thread store knows only the
 * thread id, not which project owns it). Feed rows deliberately receive only
 * `actionRequired`: Favorite remains owned by the normalized user-state
 * authority, while the project thread list also carries the active turn
 * identity.
 */
export function projectThreadLifecycleInProjectCaches(
  client: QueryClient,
  threadId: string,
  lifecycle: ThreadListLifecycle,
): void {
  patchChatRow(client, undefined, threadId, {
    threadListItem: (item) => ({ ...item, ...lifecycle }),
    projectChatItem: (item) => ({ ...item, actionRequired: lifecycle.actionRequired }),
  });
}
