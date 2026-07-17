/** Canonical device-local working-set state and its pure mutation rules. */

import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
  parseWorkingSetRouteList,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";

export const WORKING_SET_STORAGE_KEY = "meridian:working-set";

export type WorkingSetSnapshot = {
  recentRoutes: WorkingSetRoute[];
  lastThreadId: string | null;
};

export type PendingWorkingSet = {
  baseRevision: number | null;
  localVersion: number;
};

export type ProjectWorkingSetRecord = {
  snapshot: WorkingSetSnapshot;
  pending?: PendingWorkingSet;
};

type PersistedWorkingSets = {
  userId: string;
  projects: Record<string, ProjectWorkingSetRecord>;
};

export type WorkingSetStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const EMPTY_SNAPSHOT: WorkingSetSnapshot = { recentRoutes: [], lastThreadId: null };

/**
 * Canonical WorkingSetRoute builder from tab/route coordinates. Returns null
 * when a work-scoped scheme lacks its required workId — the one illegal shape
 * the discriminated union forbids.
 */
export function buildWorkingSetRoute(
  scheme: ProjectContextTreeScheme,
  path: string,
  workId: string | null | undefined,
): WorkingSetRoute | null {
  if (isWorkScopedProjectContextScheme(scheme)) {
    return workId ? { scheme, path, workId } : null;
  }
  return { scheme, path };
}

export function workingSetRouteEquals(
  left: WorkingSetRoute | undefined,
  right: WorkingSetRoute,
): boolean {
  return (
    left !== undefined &&
    left.scheme === right.scheme &&
    left.path === right.path &&
    left.workId === right.workId
  );
}

function snapshotEquals(left: WorkingSetSnapshot, right: WorkingSetSnapshot): boolean {
  return (
    left.lastThreadId === right.lastThreadId &&
    left.recentRoutes.length === right.recentRoutes.length &&
    left.recentRoutes.every((route, index) =>
      workingSetRouteEquals(route, right.recentRoutes[index] as WorkingSetRoute),
    )
  );
}

function parsePending(value: unknown): PendingWorkingSet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { baseRevision, localVersion } = value as Partial<PendingWorkingSet>;
  if (
    (baseRevision !== null && (!Number.isInteger(baseRevision) || (baseRevision ?? -1) < 0)) ||
    !Number.isInteger(localVersion) ||
    (localVersion ?? 0) < 1
  ) {
    return undefined;
  }
  return { baseRevision: baseRevision ?? null, localVersion: localVersion as number };
}

function parseProjectRecord(value: unknown): ProjectWorkingSetRecord | null {
  if (!value || typeof value !== "object") return null;
  const { snapshot, pending } = value as {
    snapshot?: Partial<WorkingSetSnapshot>;
    pending?: unknown;
  };
  if (!snapshot || typeof snapshot !== "object") return null;
  const routes = parseWorkingSetRouteList(snapshot.recentRoutes);
  if (!routes.ok || routes.value.length > 3) return null;
  if (snapshot.lastThreadId !== null && typeof snapshot.lastThreadId !== "string") return null;
  const parsedPending = pending === undefined ? undefined : parsePending(pending);
  if (pending !== undefined && !parsedPending) return null;
  return {
    snapshot: {
      recentRoutes: routes.value,
      lastThreadId: snapshot.lastThreadId as string | null,
    },
    ...(parsedPending ? { pending: parsedPending } : {}),
  };
}

function parsePersisted(raw: string | null): PersistedWorkingSets | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { userId, projects } = value as Partial<PersistedWorkingSets>;
    if (typeof userId !== "string" || !projects || typeof projects !== "object") return null;
    const validProjects: Record<string, ProjectWorkingSetRecord> = {};
    for (const [projectId, record] of Object.entries(projects)) {
      const parsed = parseProjectRecord(record);
      if (parsed) validProjects[projectId] = parsed;
    }
    return { userId, projects: validProjects };
  } catch {
    return null;
  }
}

export function mutateWorkingSet(
  record: ProjectWorkingSetRecord | undefined,
  confirmedRevision: number | null,
  mutate: (snapshot: WorkingSetSnapshot) => WorkingSetSnapshot,
): ProjectWorkingSetRecord | undefined {
  const current = record?.snapshot ?? EMPTY_SNAPSHOT;
  const snapshot = mutate(current);
  if (snapshotEquals(current, snapshot)) return record;
  return {
    snapshot,
    pending: {
      baseRevision: record?.pending?.baseRevision ?? confirmedRevision,
      localVersion: (record?.pending?.localVersion ?? 0) + 1,
    },
  };
}

export type AcknowledgeResult =
  | { status: "missing"; record: ProjectWorkingSetRecord | undefined }
  | { status: "drained"; record: ProjectWorkingSetRecord }
  | { status: "advanced"; record: ProjectWorkingSetRecord };

export function acknowledgeWorkingSet(
  record: ProjectWorkingSetRecord | undefined,
  sentLocalVersion: number,
  revision: number,
): AcknowledgeResult {
  if (!record?.pending) return { status: "missing", record };
  if (record.pending.localVersion === sentLocalVersion) {
    const { pending: _, ...clean } = record;
    return { status: "drained", record: clean };
  }
  return {
    status: "advanced",
    record: { ...record, pending: { ...record.pending, baseRevision: revision } },
  };
}

export class DeviceWorkingSetStore {
  private state: PersistedWorkingSets | null = null;

  constructor(private readonly storage: WorkingSetStorage) {}

  setUser(userId: string): void {
    if (this.state?.userId === userId) return;
    let persisted: PersistedWorkingSets | null = null;
    try {
      persisted = parsePersisted(this.storage.getItem(WORKING_SET_STORAGE_KEY));
    } catch {
      // Storage can be disabled independently of the rest of the app.
    }
    if (persisted?.userId === userId) {
      this.state = persisted;
      return;
    }
    try {
      this.storage.removeItem(WORKING_SET_STORAGE_KEY);
    } catch {
      // The in-memory identity boundary still prevents a cross-user read.
    }
    this.state = { userId, projects: {} };
  }

  read(projectId: string): ProjectWorkingSetRecord | undefined {
    return this.state?.projects[projectId];
  }

  projectIds(): string[] {
    return Object.keys(this.state?.projects ?? {});
  }

  report(
    projectId: string,
    confirmedRevision: number | null,
    mutate: (snapshot: WorkingSetSnapshot) => WorkingSetSnapshot,
  ): boolean {
    if (!this.state) return false;
    const current = this.state.projects[projectId];
    const next = mutateWorkingSet(current, confirmedRevision, mutate);
    if (next === current) return false;
    this.state.projects[projectId] = next as ProjectWorkingSetRecord;
    this.persist();
    return true;
  }

  acknowledge(projectId: string, sentLocalVersion: number, revision: number): AcknowledgeResult {
    const result = acknowledgeWorkingSet(this.read(projectId), sentLocalVersion, revision);
    if (result.status === "missing" || !this.state) return result;
    this.state.projects[projectId] = result.record;
    this.persist();
    return result;
  }

  adopt(projectId: string, snapshot: WorkingSetSnapshot): void {
    if (!this.state) return;
    const current = this.state.projects[projectId];
    if (current && !current.pending && snapshotEquals(current.snapshot, snapshot)) return;
    this.state.projects[projectId] = { snapshot };
    this.persist();
  }

  private persist(): void {
    if (!this.state) return;
    try {
      this.storage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Device-local restore remains best-effort when storage is unavailable.
    }
  }
}

export function promoteSnapshotRoute(
  snapshot: WorkingSetSnapshot,
  route: WorkingSetRoute,
): WorkingSetSnapshot {
  if (workingSetRouteEquals(snapshot.recentRoutes[0], route)) return snapshot;
  return {
    ...snapshot,
    recentRoutes: [
      route,
      ...snapshot.recentRoutes.filter((entry) => !workingSetRouteEquals(entry, route)),
    ].slice(0, 3),
  };
}

export function clearSnapshotRoutes(snapshot: WorkingSetSnapshot): WorkingSetSnapshot {
  return snapshot.recentRoutes.length === 0 ? snapshot : { ...snapshot, recentRoutes: [] };
}

export function removeSnapshotRoute(
  snapshot: WorkingSetSnapshot,
  route: WorkingSetRoute,
): WorkingSetSnapshot {
  const recentRoutes = snapshot.recentRoutes.filter(
    (entry) => !workingSetRouteEquals(entry, route),
  );
  return recentRoutes.length === snapshot.recentRoutes.length
    ? snapshot
    : { ...snapshot, recentRoutes };
}

export function setSnapshotThread(
  snapshot: WorkingSetSnapshot,
  threadId: string,
): WorkingSetSnapshot {
  return snapshot.lastThreadId === threadId ? snapshot : { ...snapshot, lastThreadId: threadId };
}
