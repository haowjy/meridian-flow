/**
 * Device-local account recents. This record is the writer's own opening
 * history; the server list may add other devices and must not demote a newer
 * local opening.
 */
import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export const ACCOUNT_RECENTS_CAP = 50;
export const ACCOUNT_RECENTS_STORAGE_KEY = "meridian:account-recents";
const SCHEMA_VERSION = 1;
const EDITOR_SCHEMES = new Set<string>(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

export type RecentsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type RecentAddress =
  | { kind: "local"; resourceHandle: string }
  | {
      kind: "document";
      scheme: ProjectContextTreeScheme;
      /** Leading-slash locator. Empty paths are not a document address. */
      path: string;
      workId: string | null;
      workSlug: string | null;
    };

export type AccountRecentItem = {
  documentId: string;
  projectId: string;
  name: string;
  openedAt: string;
  address: RecentAddress;
  /** Store revision of the last local open or locator write. */
  revision: number;
  /**
   * Store revision at which a response proved the server has this row.
   * A list that started earlier cannot treat absence as deletion.
   */
  acknowledgedRevision: number | null;
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
  workSlug: string | null;
  openedAt: string;
};

export type RecentRemoval = { documentId: string; projectId: string };

export type RecentIdentityUpdate = {
  documentId: string;
  name: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

type Tombstone = { documentId: string; projectId: string; revision: number };

type PersistedRecents = {
  schemaVersion: typeof SCHEMA_VERSION;
  userId: string;
  revision: number;
  items: AccountRecentItem[];
  removed: Tombstone[];
};

function emptyRecord(userId: string): PersistedRecents {
  return { schemaVersion: SCHEMA_VERSION, userId, revision: 0, items: [], removed: [] };
}

function isEditorScheme(scheme: string): scheme is ProjectContextTreeScheme {
  return EDITOR_SCHEMES.has(scheme);
}

export function readableRecentPath(path: string): string | null {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

function documentAddress(
  scheme: ProjectContextTreeScheme,
  path: string,
  workId: string | null,
  workSlug: string | null,
): RecentAddress | null {
  if (!isEditorScheme(scheme) || !readableRecentPath(path)) return null;
  return {
    kind: "document",
    scheme,
    path: path.startsWith("/") ? path : `/${path}`,
    workId,
    workSlug,
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
  return (
    left.scheme === right.scheme &&
    left.path === right.path &&
    left.workId === right.workId &&
    left.workSlug === right.workSlug
  );
}

function byOpenedAt(left: AccountRecentItem, right: AccountRecentItem): number {
  if (left.openedAt === right.openedAt) return left.documentId < right.documentId ? -1 : 1;
  return left.openedAt < right.openedAt ? 1 : -1;
}

function capItems(items: AccountRecentItem[]): AccountRecentItem[] {
  return [...items].sort(byOpenedAt).slice(0, ACCOUNT_RECENTS_CAP);
}

function parseItem(value: unknown): AccountRecentItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AccountRecentItem>;
  if (
    typeof item.documentId !== "string" ||
    typeof item.projectId !== "string" ||
    typeof item.name !== "string" ||
    typeof item.openedAt !== "string" ||
    typeof item.revision !== "number" ||
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
      revision: item.revision,
      acknowledgedRevision:
        typeof item.acknowledgedRevision === "number" ? item.acknowledgedRevision : null,
      address: { kind: "local", resourceHandle: address.resourceHandle },
    };
  }
  if (
    address.kind === "document" &&
    typeof address.scheme === "string" &&
    isEditorScheme(address.scheme) &&
    typeof address.path === "string" &&
    readableRecentPath(address.path)
  ) {
    return {
      documentId: item.documentId,
      projectId: item.projectId,
      name: item.name,
      openedAt: item.openedAt,
      revision: item.revision,
      acknowledgedRevision:
        typeof item.acknowledgedRevision === "number" ? item.acknowledgedRevision : null,
      address: {
        kind: "document",
        scheme: address.scheme,
        path: address.path.startsWith("/") ? address.path : `/${address.path}`,
        workId: typeof address.workId === "string" ? address.workId : null,
        workSlug: typeof address.workSlug === "string" ? address.workSlug : null,
      },
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
        const tombstone = entry as Partial<Tombstone>;
        return typeof tombstone.documentId === "string" &&
          typeof tombstone.projectId === "string" &&
          typeof tombstone.revision === "number"
          ? [
              {
                documentId: tombstone.documentId,
                projectId: tombstone.projectId,
                revision: tombstone.revision,
              },
            ]
          : [];
      })
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    userId: parsed.userId,
    revision: typeof parsed.revision === "number" ? parsed.revision : 0,
    items: capItems(items),
    removed: removed.slice(-ACCOUNT_RECENTS_CAP),
  };
}

export class DeviceAccountRecentsStore {
  private state: PersistedRecents | null = null;

  constructor(private readonly storage: RecentsStorage) {}

  get userId(): string | null {
    return this.state?.userId ?? null;
  }

  get revision(): number {
    return this.state?.revision ?? 0;
  }

  get items(): readonly AccountRecentItem[] {
    return this.state?.items ?? [];
  }

  setUser(userId: string): void {
    if (this.state?.userId === userId) return;
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

  touch(accountId: string, opening: RecentOpening): { revision: number } | null {
    const state = this.bound(accountId);
    if (!state) return null;
    if (
      opening.address.kind === "document" &&
      !documentAddress(
        opening.address.scheme,
        opening.address.path,
        opening.address.workId,
        opening.address.workSlug,
      )
    ) {
      return null;
    }
    state.revision += 1;
    const revision = state.revision;
    const previous = state.items.find((item) => item.documentId === opening.documentId);
    const next: AccountRecentItem = {
      documentId: opening.documentId,
      projectId: opening.projectId,
      name: opening.name,
      openedAt: opening.openedAt,
      address: opening.address,
      revision,
      acknowledgedRevision: previous?.acknowledgedRevision ?? null,
    };
    state.items = capItems([
      next,
      ...state.items.filter((item) => item.documentId !== opening.documentId),
    ]);
    state.removed = state.removed.filter((entry) => entry.documentId !== opening.documentId);
    this.persist();
    return { revision };
  }

  /**
   * The server has this row. Does not move rank: `recorded: false` is the
   * five-second write interval, not a request to restore the server order.
   */
  noteServerRow(accountId: string, documentId: string): boolean {
    const state = this.bound(accountId);
    if (!state) return false;
    const item = state.items.find((candidate) => candidate.documentId === documentId);
    if (!item) return false;
    state.revision += 1;
    item.acknowledgedRevision = state.revision;
    this.persist();
    return true;
  }

  applyServerList(
    accountId: string,
    projectId: string,
    rows: readonly ServerRecentRow[],
    capturedRevision: number,
  ): boolean {
    const state = this.bound(accountId);
    if (!state) return false;
    const serverById = new Map(
      rows.flatMap((row) => {
        const address = documentAddress(row.scheme, row.path, null, row.workSlug);
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
      if (item.revision > capturedRevision) {
        kept.push(item);
        continue;
      }
      if (!server) {
        const provedAbsent =
          item.acknowledgedRevision !== null && capturedRevision >= item.acknowledgedRevision;
        if (provedAbsent) changed = true;
        else kept.push(item);
        continue;
      }
      const openedAt = server.row.openedAt > item.openedAt ? server.row.openedAt : item.openedAt;
      if (openedAt !== item.openedAt) {
        changed = true;
        kept.push({ ...item, openedAt });
      } else {
        kept.push(item);
      }
    }
    for (const { row, address } of serverById.values()) {
      // A removal is authoritative until a later list no longer contains the row.
      if (removed.has(row.documentId)) continue;
      changed = true;
      kept.push({
        documentId: row.documentId,
        projectId,
        name: row.name,
        openedAt: row.openedAt,
        address,
        revision: capturedRevision,
        acknowledgedRevision: capturedRevision,
      });
    }
    const removedAfter = state.removed.filter((entry) => {
      if (entry.projectId !== projectId || entry.revision > capturedRevision) return true;
      return rows.some((row) => row.documentId === entry.documentId);
    });
    if (removedAfter.length !== state.removed.length) changed = true;
    if (!changed) return false;
    state.items = capItems(kept);
    state.removed = removedAfter.slice(-ACCOUNT_RECENTS_CAP);
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
    let changed = false;
    const kept: AccountRecentItem[] = [];
    for (const item of state.items) {
      if (removedIds.has(item.documentId)) {
        changed = true;
        continue;
      }
      const update = updates.get(item.documentId);
      if (!update) {
        kept.push(item);
        continue;
      }
      const address = documentAddress(update.scheme, update.path, update.workId, null);
      if (!address) {
        changed = true;
        removedIds.add(item.documentId);
        continue;
      }
      if (item.name === update.name && sameAddress(item.address, address)) {
        kept.push(item);
        continue;
      }
      state.revision += 1;
      changed = true;
      kept.push({
        ...item,
        name: update.name,
        address,
        revision: state.revision,
      });
    }
    if (!changed && removedIds.size === 0) return false;
    if (removedIds.size > 0) {
      state.revision += 1;
      const revision = state.revision;
      const projectOf = new Map([
        ...state.items.map((item) => [item.documentId, item.projectId] as const),
        ...input.removed.map((entry) => [entry.documentId, entry.projectId] as const),
      ]);
      const tombstones = [...removedIds].flatMap((documentId) => {
        const projectId = projectOf.get(documentId);
        return projectId ? [{ documentId, projectId, revision }] : [];
      });
      state.removed = [
        ...state.removed.filter((entry) => !removedIds.has(entry.documentId)),
        ...tombstones,
      ].slice(-ACCOUNT_RECENTS_CAP);
    }
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
      if (tab?.address.kind !== "document") return item;
      if (item.name === tab.name && sameAddress(item.address, tab.address)) return item;
      state.revision += 1;
      changed = true;
      return { ...item, name: tab.name, address: tab.address, revision: state.revision };
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
