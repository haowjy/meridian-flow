/** Serialized report-and-sweep driver for device working-set state. */

import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { updateProjectWorkingSet } from "@/client/api/projects-api";
import type { ProjectRouteData } from "@/client/query/project-route-data";
import { planWorkingSetHydration, type WorkingSetHydrationPlan } from "./hydration";
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

export class WorkingSetSyncDriver {
  private userId: string | null = null;
  private sessionGeneration = 0;
  private enabled = false;
  private readonly baselines = new Map<string, number | null>();
  private readonly scheduled = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly hydrated = new Map<string, { key: string; plan: WorkingSetHydrationPlan }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeping = false;

  constructor(
    private readonly store: DeviceWorkingSetStore,
    private readonly put: PutWorkingSet,
  ) {}

  configure(userId: string, enabled: boolean): void {
    if (this.userId !== userId) {
      this.store.setUser(userId);
      this.userId = userId;
      this.sessionGeneration += 1;
      this.baselines.clear();
      this.scheduled.clear();
      this.failures.clear();
      this.hydrated.clear();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
    this.enabled = enabled;
  }

  hydrate(projectId: string, result: ProjectRouteData["workingSet"]): WorkingSetHydrationPlan {
    if (!this.enabled) return { status: "disabled" };
    const key = result.status === "row" ? `row:${result.row.revision}` : result.status;
    const previous = this.hydrated.get(projectId);
    if (previous?.key === key) return previous.plan;

    const plan = planWorkingSetHydration(true, result, this.store.read(projectId));
    this.hydrated.set(projectId, { key, plan });
    if (plan.status === "read-degraded") {
      this.baselines.delete(projectId);
      return plan;
    }
    if (plan.status === "local") {
      this.baselines.set(projectId, plan.revision);
      if (this.store.read(projectId)?.pending) this.schedule(projectId, 0);
      return plan;
    }
    if (plan.status === "server") {
      this.store.adopt(projectId, {
        recentRoutes: plan.row.recentRoutes,
        lastThreadId: plan.row.lastThreadId,
      });
      this.baselines.set(projectId, plan.row.revision);
    }
    return plan;
  }

  establishBaseline(projectId: string, result: ProjectRouteData["workingSet"]): void {
    if (result.status === "unavailable") {
      this.baselines.delete(projectId);
      return;
    }
    this.baselines.set(projectId, result.status === "row" ? result.row.revision : null);
    if (this.store.read(projectId)?.pending) this.schedule(projectId, 0);
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

  flush(keepalive = false): void {
    for (const projectId of this.store.projectIds()) {
      if (this.store.read(projectId)?.pending) this.scheduled.add(projectId);
    }
    void this.sweep(keepalive);
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
        const sentVersion = record.pending.localVersion;
        const sentGeneration = this.sessionGeneration;
        try {
          const response = await this.put(projectId, record.snapshot, keepalive);
          if (sentGeneration !== this.sessionGeneration) continue;
          this.failures.delete(projectId);
          this.baselines.set(projectId, response.revision);
          const ack = this.store.acknowledge(projectId, sentVersion, response.revision);
          if (ack.status === "advanced") this.scheduled.add(projectId);
        } catch {
          if (sentGeneration !== this.sessionGeneration) continue;
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
    window.addEventListener("online", () => driver?.flush());
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

export function establishWorkingSetBaseline(
  projectId: string,
  result: ProjectRouteData["workingSet"],
): void {
  browserDriver()?.establishBaseline(projectId, result);
}

export function hydrateWorkingSet(
  projectId: string,
  result: ProjectRouteData["workingSet"],
): WorkingSetHydrationPlan {
  return browserDriver()?.hydrate(projectId, result) ?? { status: "disabled" };
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
