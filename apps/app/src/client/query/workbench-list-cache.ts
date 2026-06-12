// @ts-nocheck
/**
 * workbench-list-cache — direct read/write helpers for the cached workbench list in
 * the React Query client (read list, optimistic upsert). Keeps cache mutation
 * logic in one place; used by optimistic create/reconcile paths.
 */

import type { Workbench } from "@meridian/contracts/workbenches";
import type { QueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "./workbench-query-keys";

export function readWorkbenchList(client: QueryClient): Workbench[] | null {
  return client.getQueryData<Workbench[] | null>(workbenchQueryKeys.list) ?? null;
}

export function upsertWorkbenchInList(client: QueryClient, workbench: Workbench): void {
  client.setQueryData<Workbench[] | null>(workbenchQueryKeys.list, (prev) => {
    const list = prev ?? [];
    if (list.some((p) => p.id === workbench.id)) return list;
    return [workbench, ...list];
  });
}

export function patchWorkbenchInList(
  client: QueryClient,
  id: string,
  patch: Partial<Workbench>,
): void {
  client.setQueryData<Workbench[] | null>(workbenchQueryKeys.list, (prev) => {
    if (!prev) return prev;
    return prev.map((p) => (p.id === id ? { ...p, ...patch } : p));
  });
}

export function removeWorkbenchFromList(client: QueryClient, id: string): void {
  client.setQueryData<Workbench[] | null>(workbenchQueryKeys.list, (prev) =>
    prev ? prev.filter((p) => p.id !== id) : prev,
  );
}

export function restoreWorkbenchToList(client: QueryClient, workbench: Workbench): void {
  client.setQueryData<Workbench[] | null>(workbenchQueryKeys.list, (prev) => {
    const list = prev ?? [];
    if (list.some((p) => p.id === workbench.id)) return list;
    return [workbench, ...list];
  });
}
