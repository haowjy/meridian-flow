/** Sole acquisition and QueryCache installation owner for canonical Works snapshots. */

import type { CommandDriver, CommandRecord } from "@meridian/command-driver";
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";
import { listProjectWorks } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";

/** Resolve a known binding by row identity, including the locked No Work row. */
export function workFromSnapshot(
  snapshot: Pick<WorksSnapshot, "works" | "noWork"> | null | undefined,
  workId: string,
): Work | null {
  if (!snapshot) return null;
  if (workId === snapshot.noWork.id) return snapshot.noWork;
  return snapshot.works.find((work) => work.id === workId && work.deletedAt === null) ?? null;
}

/**
 * What this tab's Works include, per project: a successful read started at `startedAt` has every
 * Work command settled by then. Each successful read tells the driver, so a failed refresh
 * followed by a later good one covers both records, and no other tab's read counts here.
 */
const readObservers = new WeakMap<QueryClient, (projectId: string, startedAt: number) => void>();

export function observeWorksReads(client: QueryClient, driver: CommandDriver): () => void {
  const observer = (projectId: string, startedAt: number) =>
    void driver.observe(
      (record: CommandRecord) =>
        record.kind.startsWith("work_") &&
        (record.body as { projectId?: string }).projectId === projectId &&
        record.settledAt !== undefined &&
        record.settledAt <= startedAt,
    );
  readObservers.set(client, observer);
  return () => {
    if (readObservers.get(client) === observer) readObservers.delete(client);
  };
}

type RequestWorksSnapshot = () => Promise<WorksSnapshot>;
type ProjectState = {
  installedStart: number;
  /** When the latest read that landed began (clock time): the cache holds Works at least that new. */
  readAt: number;
  inFlight: Promise<WorksSnapshot> | null;
};

const states = new WeakMap<QueryClient, Map<string, ProjectState>>();
const nextStartedByProject = new Map<string, number>();

/** When a read began: its order among this project's reads, and the clock time. */
export type WorksRequestStart = { order: number; at: number };

/** Registers request start before any loader or live network work begins. */
export function beginWorksSnapshotRequest(projectId: string): WorksRequestStart {
  const order = (nextStartedByProject.get(projectId) ?? 0) + 1;
  nextStartedByProject.set(projectId, order);
  return { order, at: Date.now() };
}

function stateFor(client: QueryClient, projectId: string): ProjectState {
  let byProject = states.get(client);
  if (!byProject) {
    byProject = new Map();
    states.set(client, byProject);
  }
  let state = byProject.get(projectId);
  if (!state) {
    state = { installedStart: 0, readAt: 0, inFlight: null };
    byProject.set(projectId, state);
  }
  return state;
}

function compareRevision(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function currentSnapshot(client: QueryClient, projectId: string): WorksSnapshot | undefined {
  return client.getQueryData<WorksSnapshot>(projectQueryKeys.works(projectId));
}

/**
 * The one way a Works snapshot enters the cache, for a read and for route data alike: it keeps
 * the newest by revision and, when the read began later, installs it and tells the driver which
 * Work outcomes this tab's data now includes.
 */
function installSnapshot(
  client: QueryClient,
  projectId: string,
  response: WorksSnapshot,
  start: WorksRequestStart,
): WorksSnapshot {
  if (response.projectId !== projectId) {
    throw new Error(`Works snapshot project mismatch: expected ${projectId}`);
  }
  const state = stateFor(client, projectId);
  state.readAt = Math.max(state.readAt, start.at);
  const current = currentSnapshot(client, projectId);
  const ordering = current
    ? compareRevision(response.authorityRevision, current.authorityRevision)
    : 1;
  if (ordering > 0 || (ordering === 0 && start.order >= state.installedStart)) {
    client.setQueryData(projectQueryKeys.works(projectId), response);
    state.installedStart = start.order;
    readObservers.get(client)?.(projectId, start.at);
    return response;
  }
  return current ?? response;
}

/** When the latest Works read of this tab's that landed began; 0 when none has. */
export function worksReadAt(client: QueryClient, projectId: string): number {
  return stateFor(client, projectId).readAt;
}

function startAcquisition(
  client: QueryClient,
  projectId: string,
  request: RequestWorksSnapshot,
  supersede: boolean,
): Promise<WorksSnapshot> {
  const state = stateFor(client, projectId);
  if (!supersede && state.inFlight) return state.inFlight;
  const start = beginWorksSnapshotRequest(projectId);
  const acquisition = request().then((response) =>
    installSnapshot(client, projectId, response, start),
  );
  state.inFlight = acquisition;
  void acquisition
    .finally(() => {
      if (state.inFlight === acquisition) state.inFlight = null;
    })
    .catch(() => undefined);
  return acquisition;
}

/** Ordinary focus, reconnect, poll, and mounted consumers share one request. */
export function acquireWorksSnapshot(
  client: QueryClient,
  projectId: string,
  request: RequestWorksSnapshot = () => listProjectWorks(projectId),
): Promise<WorksSnapshot> {
  return startAcquisition(client, projectId, request, false);
}

/** A committed mutation starts a newer acquisition even when an older read is blocked. */
export function refreshWorksSnapshot(
  client: QueryClient,
  projectId: string,
  request: RequestWorksSnapshot = () => listProjectWorks(projectId),
): Promise<WorksSnapshot> {
  return startAcquisition(client, projectId, request, true);
}

/** Repair after an already-committed write without turning acquisition failure into command failure. */
export async function repairWorksSnapshot(
  client: QueryClient,
  projectId: string,
  request?: RequestWorksSnapshot,
): Promise<void> {
  try {
    await refreshWorksSnapshot(client, projectId, request);
  } catch {
    await client.invalidateQueries({
      queryKey: projectQueryKeys.works(projectId),
      exact: true,
      refetchType: "none",
    });
  }
}

/** Route data is hydration only and may never replace an equal or newer live snapshot. */
export function seedWorksSnapshot(
  client: QueryClient,
  snapshot: WorksSnapshot,
  started?: WorksRequestStart,
): WorksSnapshot {
  const current = currentSnapshot(client, snapshot.projectId);
  if (
    current &&
    started === undefined &&
    compareRevision(snapshot.authorityRevision, current.authorityRevision) <= 0
  )
    return current;
  const start = started ?? beginWorksSnapshotRequest(snapshot.projectId);
  nextStartedByProject.set(
    snapshot.projectId,
    Math.max(nextStartedByProject.get(snapshot.projectId) ?? 0, start.order),
  );
  return installSnapshot(client, snapshot.projectId, snapshot, start);
}
