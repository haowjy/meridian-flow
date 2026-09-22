/**
 * Device-local account recents. This record is the writer's own opening
 * history. A server list may add other devices and a newer openedAt. It does
 * not delete, overwrite a known locator, or clear a removal.
 */
import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export const ACCOUNT_RECENTS_CAP = 50;
export const ACCOUNT_RECENTS_STORAGE_KEY = "meridian:account-recents";
const SCHEMA_VERSION = 2;
const EDITOR_SCHEMES = new Set<string>(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

export type RecentsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type RecentAddress =
  | { kind: "local"; resourceHandle: string }
  | {
      kind: "document";
      scheme: ProjectContextTreeScheme;
      /** Leading-slash locator. Empty paths are not a document address. */
      path: string;
    };

export type AccountRecentItem = {
  documentId: string;
  projectId: string;
  name: string;
  openedAt: string;
  address: RecentAddress;
};

export type RecentOpening = {
  documentId: string;
  projectId: string;
  name: string;
  openedAt: string;
  address: RecentAddress;
};

export type ServerRecentRow = {
  documentId: string;
  name: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  openedAt: string;
};

export type RecentRemoval = { documentId: string; projectId: string };

export type RecentIdentityUpdate = {
  documentId: string;
  name: string;
  scheme: ProjectContextTreeScheme;
  path: string;
};

type Removal = { documentId: string; projectId: string };

type PersistedRecents = {
  schemaVersion: typeof SCHEMA_VERSION;
  userId: string;
  items: AccountRecentItem[];
  removed: Removal[];
};

function emptyRecord(userId: string): PersistedRecents {
  return { schemaVersion: SCHEMA_VERSION, userId, items: [], removed: [] };
}

function isEditorScheme(scheme: string): scheme is ProjectContextTreeScheme {
  return EDITOR_SCHEMES.has(scheme);
}

export function readableRecentPath(path: string): string | null {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

function documentAddress(scheme: string, path: string): RecentAddress | null {
  if (!isEditorScheme(scheme) || !readableRecentPath(path)) return null;
  return {
    kind: "document",
    scheme,
    path: path.startsWith("/") ? path : `/${path}`,
  };
}

function sameAddress(left: RecentAddress, right: RecentAddress): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "local" || right.kind === "local") {
    return (
      left.kind === "local" &&
      right.kind === "local" &&
      left.resourceHandle === right.resourceHandle
    );
  }
  return left.scheme === right.scheme && left.path === right.path;
}

function byOpenedAt(left: AccountRecentItem, right: AccountRecentItem): number {
  if (left.openedAt === right.openedAt) return left.documentId < right.documentId ? -1 : 1;
  return left.openedAt < right.openedAt ? 1 : -1;
}

function capItems(items: AccountRecentItem[]): AccountRecentItem[] {
  return [...items].sort(byOpenedAt).slice(0, ACCOUNT_RECENTS_CAP);
}

/** Oldest removals fall off at the cap. A list never clears one. */
function rememberRemovals(existing: readonly Removal[], next: readonly Removal[]): Removal[] {
  const replaced = new Set(next.map((entry) => entry.documentId));
  return [...existing.filter((entry) => !replaced.has(entry.documentId)), ...next].slice(
    -ACCOUNT_RECENTS_CAP,
  );
}

function parseItem(value: unknown): AccountRecentItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AccountRecentItem>;
  if (
    typeof item.documentId !== "string" ||
    typeof item.projectId !== "string" ||
    typeof item.name !== "string" ||
    typeof item.openedAt !== "string" ||
    !item.address ||
    typeof item.address !== "object"
  ) {
    return null;
  }
  const address = item.address as Partial<RecentAddress>;
  if (
    address.kind === "local" &&
    typeof address.resourceHandle === "string" &&
    address.resourceHandle
  ) {
    return {
      documentId: item.documentId,
      projectId: item.projectId,
      name: item.name,
      openedAt: item.openedAt,
      address: { kind: "local", resourceHandle: address.resourceHandle },
    };
  }
  if (
    address.kind === "document" &&
    typeof address.scheme === "string" &&
    typeof address.path === "string"
  ) {
    const document = documentAddress(address.scheme, address.path);
    if (!document) return null;
    return {
      documentId: item.documentId,
      projectId: item.projectId,
      name: item.name,
      openedAt: item.openedAt,
      address: document,
    };
  }
  return null;
}

function parsePersisted(raw: string | null): PersistedRecents | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<PersistedRecents>;
  if (parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.userId !== "string") return null;
  const items = Array.isArray(parsed.items)
    ? parsed.items.flatMap((item) => parseItem(item) ?? [])
    : [];
  const removed = Array.isArray(parsed.removed)
    ? parsed.removed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const removal = entry as Partial<Removal>;
        return typeof removal.documentId === "string" && typeof removal.projectId === "string"
          ? [{ documentId: removal.documentId, projectId: removal.projectId }]
          : [];
      })
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    userId: parsed.userId,
    items: capItems(items),
    removed: removed.slice(-ACCOUNT_RECENTS_CAP),
  };
}

export class DeviceAccountRecentsStore {
  private state: PersistedRecents | null = null;
  /** Session fence for a cached list. Not durable, and not an item revision. */
  private bindEpoch = 0;

  constructor(private readonly storage: RecentsStorage) {}

  get userId(): string | null {
    return this.state?.userId ?? null;
  }

  get epoch(): number {
    return this.bindEpoch;
  }

  get items(): readonly AccountRecentItem[] {
    return this.state?.items ?? [];
  }

  setUser(userId: string): void {
    if (this.state?.userId === userId) return;
    this.bindEpoch += 1;
    let persisted: PersistedRecents | null = null;
    try {
      persisted = parsePersisted(this.storage.getItem(ACCOUNT_RECENTS_STORAGE_KEY));
    } catch {
      persisted = null;
    }
    if (persisted?.userId === userId) {
      this.state = persisted;
      return;
    }
    try {
      this.storage.removeItem(ACCOUNT_RECENTS_STORAGE_KEY);
    } catch {
      // The in-memory boundary still refuses a cross-account read.
    }
    this.state = emptyRecord(userId);
  }

  forProject(projectId: string): AccountRecentItem[] {
    return (this.state?.items ?? []).filter((item) => item.projectId === projectId);
  }

  touch(accountId: string, opening: RecentOpening): boolean {
    const state = this.bound(accountId);
    if (!state) return false;
    if (
      opening.address.kind === "document" &&
      !documentAddress(opening.address.scheme, opening.address.path)
    ) {
      return false;
    }
    const next: AccountRecentItem = {
      documentId: opening.documentId,
      projectId: opening.projectId,
      name: opening.name,
      openedAt: opening.openedAt,
      address: opening.address,
    };
    state.items = capItems([
      next,
      ...state.items.filter((item) => item.documentId !== opening.documentId),
    ]);
    state.removed = state.removed.filter((entry) => entry.documentId !== opening.documentId);
    this.persist();
    return true;
  }

  /**
   * Add rows this device has not ranked, and adopt a newer openedAt.
   * Never deletes, never overwrites a known locator, never clears a removal.
   * A payload from another bind is ignored.
   */
  applyServerList(
    accountId: string,
    projectId: string,
    rows: readonly ServerRecentRow[],
    bindEpoch: number,
  ): boolean {
    const state = this.bound(accountId);
    if (!state || bindEpoch !== this.bindEpoch) return false;
    const serverById = new Map(
      rows.flatMap((row) => {
        const address = documentAddress(row.scheme, row.path);
        return address ? [[row.documentId, { row, address }] as const] : [];
      }),
    );
    const removed = new Set(
      state.removed
        .filter((entry) => entry.projectId === projectId)
        .map((entry) => entry.documentId),
    );
    let changed = false;
    const kept: AccountRecentItem[] = [];
    for (const item of state.items) {
      if (item.projectId !== projectId) {
        kept.push(item);
        continue;
      }
      const server = serverById.get(item.documentId);
      serverById.delete(item.documentId);
      if (!server || server.row.openedAt <= item.openedAt) {
        kept.push(item);
        continue;
      }
      changed = true;
      kept.push({ ...item, openedAt: server.row.openedAt });
    }
    for (const { row, address } of serverById.values()) {
      if (removed.has(row.documentId)) continue;
      changed = true;
      kept.push({
        documentId: row.documentId,
        projectId,
        name: row.name,
        openedAt: row.openedAt,
        address,
      });
    }
    if (!changed) return false;
    state.items = capItems(kept);
    this.persist();
    return true;
  }

  applyAvailability(
    accountId: string,
    input: { removed: readonly RecentRemoval[]; updates: readonly RecentIdentityUpdate[] },
  ): boolean {
    const state = this.bound(accountId);
    if (!state) return false;
    const removedIds = new Set(input.removed.map((entry) => entry.documentId));
    const updates = new Map(input.updates.map((update) => [update.documentId, update]));
    // Availability batches include other consumers' documents. Only remember
    // rows removed from this record, or unrelated ids can evict a real removal.
    const dropped: Removal[] = [];
    let changed = false;
    const kept: AccountRecentItem[] = [];
    for (const item of state.items) {
      if (removedIds.has(item.documentId)) {
        dropped.push({ documentId: item.documentId, projectId: item.projectId });
        changed = true;
        continue;
      }
      const update = updates.get(item.documentId);
      if (!update) {
        kept.push(item);
        continue;
      }
      const address = documentAddress(update.scheme, update.path);
      if (!address) {
        changed = true;
        dropped.push({ documentId: item.documentId, projectId: item.projectId });
        continue;
      }
      if (item.name === update.name && sameAddress(item.address, address)) {
        kept.push(item);
        continue;
      }
      changed = true;
      kept.push({ ...item, name: update.name, address });
    }
    if (!changed) return false;
    if (dropped.length > 0) state.removed = rememberRemovals(state.removed, dropped);
    state.items = capItems(kept);
    this.persist();
    return true;
  }

  patchFromTabs(
    accountId: string,
    projectId: string,
    tabs: readonly { documentId: string; name: string; address: RecentAddress }[],
  ): boolean {
    const state = this.bound(accountId);
    if (!state) return false;
    const byId = new Map(tabs.map((tab) => [tab.documentId, tab]));
    let changed = false;
    const items = state.items.map((item) => {
      if (item.projectId !== projectId) return item;
      const tab = byId.get(item.documentId);
      if (!tab) return item;
      if (
        tab.address.kind === "document" &&
        !documentAddress(tab.address.scheme, tab.address.path)
      ) {
        return item;
      }
      if (item.name === tab.name && sameAddress(item.address, tab.address)) return item;
      changed = true;
      return { ...item, name: tab.name, address: tab.address };
    });
    if (!changed) return false;
    state.items = items;
    this.persist();
    return true;
  }

  private bound(accountId: string): PersistedRecents | null {
    return this.state?.userId === accountId ? this.state : null;
  }

  private persist(): void {
    if (!this.state) return;
    try {
      this.storage.setItem(ACCOUNT_RECENTS_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Device-local history remains best-effort when storage is unavailable.
    }
  }
}
