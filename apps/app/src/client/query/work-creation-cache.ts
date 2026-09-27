/** Per-project TanStack cache projection for client-addressable Work creates. */
import type { CreateWorkRequest, Work, WorksSnapshot } from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "./project-query-keys";

export type WorkCreationRecord = {
  workId: string;
  projectId: string;
  request: CreateWorkRequest & { id: string };
  work: Work | null;
  accountSignal: AbortSignal;
  status: "pending" | "failed" | "confirmed";
  error: string | null;
};

export type WorkCreationMap = Record<string, WorkCreationRecord>;

export function readWorkCreations(client: QueryClient, projectId: string): WorkCreationMap {
  return client.getQueryData<WorkCreationMap>(projectQueryKeys.workCreations(projectId)) ?? {};
}

export function writeWorkCreation(
  client: QueryClient,
  projectId: string,
  record: WorkCreationRecord,
): void {
  client.setQueryData<WorkCreationMap>(projectQueryKeys.workCreations(projectId), (current) => ({
    ...current,
    [record.workId]: record,
  }));
}

export function removeWorkCreation(client: QueryClient, projectId: string, workId: string): void {
  client.setQueryData<WorkCreationMap>(projectQueryKeys.workCreations(projectId), (current) => {
    if (!current?.[workId]) return current;
    const next = { ...current };
    delete next[workId];
    return next;
  });
}

export function workCreationMapForQuery(records: WorkCreationMap | undefined): WorkCreationMap {
  return records ?? {};
}

/** Keep a committed Work visible until its versioned catalog snapshot catches up. */
export function confirmedWorkIdsInSnapshot(snapshot: WorksSnapshot | undefined): Set<string> {
  return new Set(snapshot?.works.map((work) => work.id) ?? []);
}

/** Recover a create whose response may have been lost, using its stable client ID. */
export async function createWorkWithRecovery(
  request: CreateWorkRequest & { id: string },
  create: (request: CreateWorkRequest) => Promise<Work>,
  lookup: () => Promise<WorksSnapshot>,
): Promise<Work> {
  try {
    return await create(request);
  } catch (error) {
    try {
      const committed = (await lookup()).works.find((work) => work.id === request.id);
      if (committed) return committed;
    } catch {
      // Preserve the original POST error when the outcome cannot be resolved.
    }
    throw error;
  }
}
