/**
 * Browser owner for account recents. Reads are synchronous; account mismatch
 * discards the record before any consumer can paint it.
 */
import {
  type AccountRecentItem,
  DeviceAccountRecentsStore,
  type RecentAddress,
  type RecentIdentityUpdate,
  type RecentOpening,
  type RecentRemoval,
  type ServerRecentRow,
} from "./store";

export { ACCOUNT_RECENTS_CAP, readableRecentPath } from "./store";
export type {
  AccountRecentItem,
  RecentAddress,
  RecentIdentityUpdate,
  RecentOpening,
  RecentRemoval,
  ServerRecentRow,
};

export type AccountRecentsSnapshot = {
  bound: boolean;
  userId: string | null;
  bindEpoch: number;
  items: readonly AccountRecentItem[];
};

const UNBOUND: AccountRecentsSnapshot = { bound: false, userId: null, bindEpoch: 0, items: [] };

let store: DeviceAccountRecentsStore | null = null;
let snapshot: AccountRecentsSnapshot = UNBOUND;
const listeners = new Set<() => void>();

function browserStore(): DeviceAccountRecentsStore | null {
  if (typeof window === "undefined") return null;
  store ??= new DeviceAccountRecentsStore({
    // Access the browser getter inside the store's storage-error boundary too.
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  });
  return store;
}

function publish(): void {
  const current = browserStore();
  snapshot = current
    ? {
        bound: current.userId !== null,
        userId: current.userId,
        bindEpoch: current.epoch,
        items: current.items,
      }
    : UNBOUND;
  for (const listener of listeners) listener();
}

export function subscribeAccountRecents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAccountRecentsSnapshot(): AccountRecentsSnapshot {
  return snapshot;
}

export function getAccountRecentsServerSnapshot(): AccountRecentsSnapshot {
  return UNBOUND;
}

export function bindAccountRecents(userId: string): void {
  const current = browserStore();
  if (!current || current.userId === userId) return;
  current.setUser(userId);
  snapshot = {
    bound: true,
    userId: current.userId,
    bindEpoch: current.epoch,
    items: current.items,
  };
  queueMicrotask(publish);
}

export function readAccountRecents(projectId: string): readonly AccountRecentItem[] {
  return browserStore()?.forProject(projectId) ?? [];
}

export function touchAccountRecent(accountId: string, opening: RecentOpening): boolean {
  const touched = browserStore()?.touch(accountId, opening) ?? false;
  if (touched) publish();
  return touched;
}

export function applyServerRecentList(
  accountId: string,
  projectId: string,
  rows: readonly ServerRecentRow[],
  bindEpoch: number,
): void {
  if (browserStore()?.applyServerList(accountId, projectId, rows, bindEpoch)) publish();
}

export function applyRecentAvailability(
  accountId: string,
  input: { removed: readonly RecentRemoval[]; updates: readonly RecentIdentityUpdate[] },
): void {
  if (browserStore()?.applyAvailability(accountId, input)) publish();
}

export function patchAccountRecentsFromTabs(
  accountId: string,
  projectId: string,
  tabs: readonly { documentId: string; name: string; address: RecentAddress }[],
): void {
  if (browserStore()?.patchFromTabs(accountId, projectId, tabs)) publish();
}
