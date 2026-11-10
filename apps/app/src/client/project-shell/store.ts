/**
 * The project's stored shell state, per (account, project) in this browser tab and seeded once from
 * the device by `tab-first-remembered-id`, so two browser tabs on one project do not fight over it.
 * Today that is the Work scope; the sidebar list and the held pick join it in later phases.
 */
import { useSyncExternalStore } from "react";
import { readRememberedId, writeRememberedId } from "../tab-first-remembered-id";

/** A Work row id, or `none` for No Work. Only the Work picker writes it. */
export type ProjectScope = string;
export const NO_SCOPE = "none";

const listeners = new Map<string, Set<() => void>>();
const recordKey = (accountId: string, projectId: string) => `${accountId}:${projectId}`;

export function readProjectScope(accountId: string, projectId: string): ProjectScope {
  return readRememberedId("work", accountId, projectId) ?? NO_SCOPE;
}

export function writeProjectScope(accountId: string, projectId: string, scope: ProjectScope): void {
  if (readProjectScope(accountId, projectId) === scope) return;
  writeRememberedId("work", accountId, projectId, scope);
  for (const listener of listeners.get(recordKey(accountId, projectId)) ?? []) listener();
}

function subscribe(accountId: string, projectId: string, listener: () => void) {
  const key = recordKey(accountId, projectId);
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
  };
}

/** The stored scope, re-read when this tab's scope changes. */
export function useProjectScope(accountId: string, projectId: string): ProjectScope {
  return useSyncExternalStore(
    (listener) => subscribe(accountId, projectId, listener),
    () => readProjectScope(accountId, projectId),
    () => NO_SCOPE,
  );
}
