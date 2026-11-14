/** Refusals the writer has put away: they stay in the list, and no longer show on the row. Kept per account on this device. */
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const sets = new Map<string, Set<string>>();
let revision = 0;

const keyOf = (accountId: string) => `meridian:tree-failures-dismissed:v1:${accountId}`;

function load(accountId: string): Set<string> {
  let set = sets.get(accountId);
  if (!set) {
    try {
      set = new Set(JSON.parse(localStorage.getItem(keyOf(accountId)) ?? "[]") as string[]);
    } catch {
      // A stored value another build wrote that this one cannot read: start empty.
      set = new Set();
    }
    sets.set(accountId, set);
  }
  return set;
}

export function dismissedFailures(accountId: string): ReadonlySet<string> {
  return load(accountId);
}

export function dismissFailure(accountId: string, record: string): void {
  const set = load(accountId);
  if (set.has(record)) return;
  set.add(record);
  localStorage.setItem(keyOf(accountId), JSON.stringify([...set]));
  revision += 1;
  for (const listener of listeners) listener();
}

/** Changes whenever a refusal is put away. */
export function useDismissalRevision(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => revision,
    () => 0,
  );
}
