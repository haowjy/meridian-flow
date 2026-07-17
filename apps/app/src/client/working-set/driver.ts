/** Serialized report-and-sweep driver for device working-set state. */

import type { ProjectWorkingSet, WorkingSetRoute } from "@meridian/contracts/protocol";
import { getProjectWorkingSet, updateProjectWorkingSet } from "@/client/api/projects-api";
import type { ProjectRouteData } from "@/client/query/project-route-data";
import {
  planSuspectBaselineConfirmation,
  planWorkingSetHydration,
  type WorkingSetHydrationPlan,
} from "./hydration";
import {
  clearSnapshotRoutes,
  DeviceWorkingSetStore,
  type ProjectWorkingSetRecord,
  promoteSnapshotRoute,
  removeSnapshotRoute,
  setSnapshotThread,
  type WorkingSetStorage,
} from "./store";

const REPORT_DEBOUNCE_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;

export function canSweepWorkingSet(
  enabled: boolean,
  baselineEstablished: boolean,
  record: ProjectWorkingSetRecord | undefined,
): boolean {
  return enabled && baselineEstablished && record?.pending !== undefined;
}

type WorkingSetResponse = { revision: number };
type PutWorkingSet = (
  projectId: string,
  snapshot: ProjectWorkingSetRecord["snapshot"],
  keepalive: boolean,
) => Promise<WorkingSetResponse>;
type GetWorkingSet = (projectId: string) => Promise<ProjectWorkingSet | null>;

export class WorkingSetSyncDriver {
  private userId: string | null = null;
  private sessionGeneration = 0;
  private enabled = false;
  private readonly baselines = new Map<string, number | null>();
  private readonly suspectBaselines = new Set<string>();
  private readonly scheduled = new Set<string>();
  private readonly failures = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeping = false;

  constructor(
    private readonly store: DeviceWorkingSetStore,
    private readonly put: PutWorkingSet,
    private readonly get: GetWorkingSet = getProjectWorkingSet,
  ) {}

  configure(userId: string, enabled: boolean): void {
    if (this.userId !== userId) {
      this.store.setUser(userId);
      this.userId = userId;
      this.sessionGeneration += 1;
      this.baselines.clear();
      this.suspectBaselines.clear();
      this.scheduled.clear();
      this.failures.clear();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.enabled && enabled) this.baselines.clear();
    this.enabled = enabled;
  }

  hydrate(projectId: string, result: ProjectRouteData["workingSet"]): WorkingSetHydrationPlan {
    if (!this.enabled) return { status: "disabled" };
    const plan = planWorkingSetHydration(true, result, this.store.read(projectId));
    if (plan.status === "read-degraded") {
      this.baselines.delete(projectId);
      this.suspectBaselines.delete(projectId);
      return plan;
    }
    if (this.suspectBaselines.has(projectId)) return plan;
    if (plan.status === "local") {
      this.confirmBaseline(projectId, plan.revision);
      if (this.store.read(projectId)?.pending) this.schedule(projectId, 0);
      return plan;
    }
    if (plan.status === "server") {
      this.store.adopt(projectId, {
        recentRoutes: plan.row.recentRoutes,
        lastThreadId: plan.row.lastThreadId,
      });
      this.confirmBaseline(projectId, plan.row.revision);
    }
    return plan;
  }

  async retryHydration(projectId: string): Promise<WorkingSetHydrationPlan> {
    if (!this.enabled) return { status: "disabled" };
    const generation = this.sessionGeneration;
    try {
      const row = await this.get(projectId);
      if (generation !== this.sessionGeneration || !this.enabled) return { status: "disabled" };
      this.suspectBaselines.delete(projectId);
      return this.hydrate(projectId, row ? { status: "row", row } : { status: "absent" });
    } catch {
      if (generation !== this.sessionGeneration || !this.enabled) return { status: "disabled" };
      this.markSuspect(projectId);
      return this.hydrate(projectId, { status: "unavailable" });
    }
  }

  readRecentRoutes(projectId: string): WorkingSetRoute[] {
    return this.store.read(projectId)?.snapshot.recentRoutes ?? [];
  }

  readRecord(projectId: string): ProjectWorkingSetRecord | undefined {
    return this.store.read(projectId);
  }

  promoteRoute(projectId: string, route: WorkingSetRoute): void {
    this.report(projectId, (snapshot) => promoteSnapshotRoute(snapshot, route));
  }

  clearRoutes(projectId: string): void {
    this.report(projectId, clearSnapshotRoutes);
  }

  removeRoute(projectId: string, route: WorkingSetRoute): void {
    this.report(projectId, (snapshot) => removeSnapshotRoute(snapshot, route));
  }

  setThread(projectId: string, threadId: string): void {
    this.report(projectId, (snapshot) => setSnapshotThread(snapshot, threadId));
  }

  markSuspectOnReconnect(): void {
    for (const projectId of this.baselines.keys()) {
      this.suspectBaselines.add(projectId);
    }
  }

  flush(keepalive = false): void {
    for (const projectId of this.store.projectIds()) {
      if (this.store.read(projectId)?.pending) this.scheduled.add(projectId);
    }
    void this.sweep(keepalive);
  }

  private confirmBaseline(projectId: string, revision: number | null): void {
    this.baselines.set(projectId, revision);
    this.suspectBaselines.delete(projectId);
  }

  private markSuspect(projectId: string): void {
    if (this.baselines.has(projectId)) this.suspectBaselines.add(projectId);
  }

  private report(projectId: string, mutate: Parameters<DeviceWorkingSetStore["report"]>[2]): void {
    const changed = this.store.report(projectId, this.baselines.get(projectId) ?? null, mutate);
    if (changed) this.schedule(projectId, REPORT_DEBOUNCE_MS);
  }

  private schedule(projectId: string, delay: number): void {
    this.scheduled.add(projectId);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sweep(false);
    }, delay);
  }

  private async confirmSuspectBaseline(projectId: string): Promise<boolean> {
    const generation = this.sessionGeneration;
    try {
      const row = await this.get(projectId);
      if (generation !== this.sessionGeneration || !this.enabled) return false;
      const result = row ? { status: "row" as const, row } : { status: "absent" as const };
      const confirmation = planSuspectBaselineConfirmation(result, this.store.read(projectId));
      if (confirmation.status === "read-degraded") return false;
      if (confirmation.adopt) this.store.adopt(projectId, confirmation.adopt);
      this.confirmBaseline(projectId, confirmation.revision);
      return true;
    } catch {
      return false;
    }
  }

  private async sweep(keepalive: boolean): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      while (this.scheduled.size > 0) {
        const projectId = this.scheduled.values().next().value as string;
        this.scheduled.delete(projectId);
        const record = this.store.read(projectId);
        if (!canSweepWorkingSet(this.enabled, this.baselines.has(projectId), record)) continue;
        if (!record?.pending) continue;
        if (this.suspectBaselines.has(projectId)) {
          const confirmed = await this.confirmSuspectBaseline(projectId);
          if (!confirmed) {
            const failures = (this.failures.get(projectId) ?? 0) + 1;
            this.failures.set(projectId, failures);
            this.schedule(projectId, Math.min(1_000 * 2 ** (failures - 1), MAX_BACKOFF_MS));
            break;
          }
        }
        const current = this.store.read(projectId);
        if (!current?.pending) continue;
        const sentVersion = current.pending.localVersion;
        const sentGeneration = this.sessionGeneration;
        try {
          const response = await this.put(projectId, current.snapshot, keepalive);
          if (sentGeneration !== this.sessionGeneration) continue;
          this.failures.delete(projectId);
          this.confirmBaseline(projectId, response.revision);
          const ack = this.store.acknowledge(projectId, sentVersion, response.revision);
          if (ack.status === "advanced") this.scheduled.add(projectId);
        } catch {
          if (sentGeneration !== this.sessionGeneration) continue;
          this.markSuspect(projectId);
          const failures = (this.failures.get(projectId) ?? 0) + 1;
          this.failures.set(projectId, failures);
          this.schedule(projectId, Math.min(1_000 * 2 ** (failures - 1), MAX_BACKOFF_MS));
          break;
        }
      }
    } finally {
      this.sweeping = false;
      const nextProjectId = this.scheduled.values().next().value;
      if (nextProjectId && !this.timer) this.schedule(nextProjectId, 0);
    }
  }
}

let driver: WorkingSetSyncDriver | null = null;
let listenersInstalled = false;

const unavailableStorage: WorkingSetStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

export function getWorkingSetStorage(browser: Pick<Window, "localStorage">): WorkingSetStorage {
  try {
    return browser.localStorage;
  } catch {
    return unavailableStorage;
  }
}

function browserDriver(): WorkingSetSyncDriver | null {
  if (typeof window === "undefined") return null;
  driver ??= new WorkingSetSyncDriver(
    new DeviceWorkingSetStore(getWorkingSetStorage(window)),
    (projectId, snapshot, keepalive) => updateProjectWorkingSet(projectId, snapshot, { keepalive }),
  );
  if (!listenersInstalled) {
    listenersInstalled = true;
    window.addEventListener("online", () => {
      driver?.markSuspectOnReconnect();
      driver?.flush();
    });
    window.addEventListener("pagehide", () => driver?.flush(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") driver?.flush(true);
    });
  }
  return driver;
}

export function configureWorkingSetSync(userId: string, enabled: boolean): void {
  browserDriver()?.configure(userId, enabled);
}

export function hydrateWorkingSet(
  projectId: string,
  result: ProjectRouteData["workingSet"],
  enabled: boolean,
): WorkingSetHydrationPlan {
  if (!enabled) return { status: "disabled" };
  return browserDriver()?.hydrate(projectId, result) ?? { status: "disabled" };
}

export function retryWorkingSetHydration(projectId: string): Promise<WorkingSetHydrationPlan> {
  return browserDriver()?.retryHydration(projectId) ?? Promise.resolve({ status: "disabled" });
}

export function readRecentRoutes(projectId: string): WorkingSetRoute[] {
  return browserDriver()?.readRecentRoutes(projectId) ?? [];
}

export function readRememberedThread(projectId: string): string | null {
  return browserDriver()?.readRecord(projectId)?.snapshot.lastThreadId ?? null;
}

export function promoteRoute(projectId: string, route: WorkingSetRoute): void {
  browserDriver()?.promoteRoute(projectId, route);
}

export function clearRoutes(projectId: string): void {
  browserDriver()?.clearRoutes(projectId);
}

export function removeRoute(projectId: string, route: WorkingSetRoute): void {
  browserDriver()?.removeRoute(projectId, route);
}

export function setThread(projectId: string, threadId: string): void {
  browserDriver()?.setThread(projectId, threadId);
}
