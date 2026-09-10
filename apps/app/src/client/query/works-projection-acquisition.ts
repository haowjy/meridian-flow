/** Sole acquisition and QueryCache installation owner for canonical Works snapshots. */
import type { WorksSnapshot } from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";
import { listProjectWorks } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";

type RequestWorksSnapshot = () => Promise<WorksSnapshot>;
type ProjectState = {
  installedStart: number;
  inFlight: Promise<WorksSnapshot> | null;
};

const states = new WeakMap<QueryClient, Map<string, ProjectState>>();
const nextStartedByProject = new Map<string, number>();

/** Registers request start before any loader or live network work begins. */
export function beginWorksSnapshotRequest(projectId: string): number {
  const started = (nextStartedByProject.get(projectId) ?? 0) + 1;
  nextStartedByProject.set(projectId, started);
  return started;
}

function stateFor(client: QueryClient, projectId: string): ProjectState {
  let byProject = states.get(client);
  if (!byProject) {
    byProject = new Map();
    states.set(client, byProject);
  }
  let state = byProject.get(projectId);
  if (!state) {
    state = { installedStart: 0, inFlight: null };
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

function installResponse(
  client: QueryClient,
  projectId: string,
  response: WorksSnapshot,
  started: number,
): WorksSnapshot {
  if (response.projectId !== projectId) {
    throw new Error(`Works snapshot project mismatch: expected ${projectId}`);
  }
  const state = stateFor(client, projectId);
  const current = currentSnapshot(client, projectId);
  const ordering = current
    ? compareRevision(response.authorityRevision, current.authorityRevision)
    : 1;
  if (ordering > 0 || (ordering === 0 && started >= state.installedStart)) {
    client.setQueryData(projectQueryKeys.works(projectId), response);
    state.installedStart = started;
    return response;
  }
  return current ?? response;
}

function startAcquisition(
  client: QueryClient,
  projectId: string,
  request: RequestWorksSnapshot,
  supersede: boolean,
): Promise<WorksSnapshot> {
  const state = stateFor(client, projectId);
  if (!supersede && state.inFlight) return state.inFlight;
  const started = beginWorksSnapshotRequest(projectId);
  const acquisition = request().then((response) =>
    installResponse(client, projectId, response, started),
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
  started?: number,
): WorksSnapshot {
  const current = currentSnapshot(client, snapshot.projectId);
  const state = stateFor(client, snapshot.projectId);
  if (
    current &&
    started === undefined &&
    compareRevision(snapshot.authorityRevision, current.authorityRevision) <= 0
  )
    return current;
  const requestStarted = started ?? beginWorksSnapshotRequest(snapshot.projectId);
  nextStartedByProject.set(
    snapshot.projectId,
    Math.max(nextStartedByProject.get(snapshot.projectId) ?? 0, requestStarted),
  );
  if (current && compareRevision(snapshot.authorityRevision, current.authorityRevision) < 0) {
    return current;
  }
  if (
    current &&
    compareRevision(snapshot.authorityRevision, current.authorityRevision) === 0 &&
    requestStarted < state.installedStart
  )
    return current;
  client.setQueryData(projectQueryKeys.works(snapshot.projectId), snapshot);
  state.installedStart = requestStarted;
  return snapshot;
}
