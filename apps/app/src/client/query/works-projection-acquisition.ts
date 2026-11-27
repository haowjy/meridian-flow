import type { CommandDriver, CommandRecord } from "@meridian/command-driver";
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";
import { listProjectWorks } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";

export function workFromSnapshot(
  snapshot: Pick<WorksSnapshot, "works" | "noWork"> | null | undefined,
  workId: string,
): Work | null {
  if (!snapshot) return null;
  if (workId === snapshot.noWork.id) return snapshot.noWork;
  return snapshot.works.find((work) => work.id === workId && work.deletedAt === null) ?? null;
}

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
  const stopWaiting = driver.subscribe(() => {
    if (!driver.hasRead) return;
    stopWaiting();
    for (const [projectId, state] of states.get(client) ?? [])
      if (state.installedAt > 0) observer(projectId, state.installedAt);
  });
  return () => {
    stopWaiting();
    if (readObservers.get(client) === observer) readObservers.delete(client);
  };
}

type RequestWorksSnapshot = () => Promise<WorksSnapshot>;
type ProjectState = {
  installedStart: number;
  installedAt: number;
  inFlight: Promise<WorksSnapshot> | null;
  inFlightAt: number;
};

const states = new WeakMap<QueryClient, Map<string, ProjectState>>();
const nextStartedByProject = new Map<string, number>();

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
    state = { installedStart: 0, installedAt: 0, inFlight: null, inFlightAt: 0 };
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
  const current = currentSnapshot(client, projectId);
  const ordering = current
    ? compareRevision(response.authorityRevision, current.authorityRevision)
    : 1;
  if (ordering > 0 || (ordering === 0 && start.order >= state.installedStart)) {
    client.setQueryData(projectQueryKeys.works(projectId), response);
    state.installedStart = start.order;
    state.installedAt = start.at;
    readObservers.get(client)?.(projectId, start.at);
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
  const start = beginWorksSnapshotRequest(projectId);
  const acquisition = request().then((response) =>
    installSnapshot(client, projectId, response, start),
  );
  state.inFlight = acquisition;
  state.inFlightAt = start.at;
  void acquisition
    .finally(() => {
      if (state.inFlight === acquisition) state.inFlight = null;
    })
    .catch(() => undefined);
  return acquisition;
}

export function acquireWorksSnapshot(
  client: QueryClient,
  projectId: string,
  request: RequestWorksSnapshot = () => listProjectWorks(projectId),
): Promise<WorksSnapshot> {
  return startAcquisition(client, projectId, request, false);
}

export function refreshWorksSnapshot(
  client: QueryClient,
  projectId: string,
  request: RequestWorksSnapshot = () => listProjectWorks(projectId),
): Promise<WorksSnapshot> {
  return startAcquisition(client, projectId, request, true);
}

export function repairWorksSnapshot(
  client: QueryClient,
  projectId: string,
  request?: RequestWorksSnapshot,
): Promise<void> {
  return settleRepair(client, projectId, refreshWorksSnapshot(client, projectId, request));
}

export function refreshWorksSnapshotSince(
  client: QueryClient,
  projectId: string,
  since: number,
): Promise<void> {
  const state = stateFor(client, projectId);
  if (state.inFlight && state.inFlightAt >= since)
    return settleRepair(client, projectId, state.inFlight);
  if (state.installedAt >= since || (!currentSnapshot(client, projectId) && !state.inFlight))
    return Promise.resolve();
  return repairWorksSnapshot(client, projectId);
}

async function settleRepair(
  client: QueryClient,
  projectId: string,
  read: Promise<WorksSnapshot>,
): Promise<void> {
  try {
    await read;
  } catch {
    await client.invalidateQueries({
      queryKey: projectQueryKeys.works(projectId),
      exact: true,
      refetchType: "none",
    });
  }
}

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
