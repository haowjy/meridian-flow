import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { defaultThreadTitle } from "@/lib/thread-title";
import { patchChatRow } from "./chat-projections";
import { projectQueryKeys } from "./project-query-keys";

function chatLists(client: QueryClient) {
  return client
    .getQueryCache()
    .findAll({ queryKey: projectQueryKeys.all })
    .filter((query) => query.queryKey[2] === "threads");
}

export function cachedChatTitle(client: QueryClient, threadId: string): string | null {
  for (const query of chatLists(client)) {
    const title = (query.state.data as ThreadListItem[] | null | undefined)
      ?.find((thread) => thread.id === threadId)
      ?.title?.trim();
    if (title && title !== defaultThreadTitle()) return title;
  }
  return null;
}

export function useCachedChatTitles(): (threadId: string) => string | null {
  const client = useQueryClient();
  const subscribe = useCallback(
    (listener: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.query.queryKey[2] === "threads") listener();
      }),
    [client],
  );
  const version = useSyncExternalStore(subscribe, () =>
    chatLists(client)
      .map((query) => query.state.dataUpdatedAt)
      .join(),
  );
  return useCallback((threadId: string) => cachedChatTitle(client, threadId), [client, version]);
}

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
        // Both modes belong to the list's own refetch: a snapshot may be older than it.
        const { aiWriteMode: _owned, effectiveAiWriteMode: _effective, ...rest } = thread;
        return list.map((t) => (t.id === thread.id ? { ...t, ...rest, ...(lifecycle ?? {}) } : t));
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
