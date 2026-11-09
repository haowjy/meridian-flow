/** This tab's Work scope, with a device-local starting point for new tabs. */
import { useSyncExternalStore } from "react";
import { readRememberedId, writeRememberedId } from "./tab-first-remembered-id";

const listeners = new Map<string, Set<() => void>>();
const scopeKey = (accountId: string, projectId: string) => `${accountId}:${projectId}`;

export function readCurrentWork(accountId: string, projectId: string): string | null {
  return readRememberedId("work", accountId, projectId);
}

export function writeCurrentWork(accountId: string, projectId: string, workId: string): void {
  if (readCurrentWork(accountId, projectId) === workId) return;
  writeRememberedId("work", accountId, projectId, workId);
  for (const listener of listeners.get(scopeKey(accountId, projectId)) ?? []) listener();
}

function subscribeCurrentWork(accountId: string, projectId: string, listener: () => void) {
  const key = scopeKey(accountId, projectId);
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
  };
}

/** The remembered Work id, re-read when this tab's scope changes. */
export function useCurrentWork(accountId: string, projectId: string): string | null {
  return useSyncExternalStore(
    (listener) => subscribeCurrentWork(accountId, projectId, listener),
    () => readCurrentWork(accountId, projectId),
    () => null,
  );
}
