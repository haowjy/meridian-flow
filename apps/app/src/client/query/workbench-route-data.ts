// @ts-nocheck
/**
 * workbench-route-data — server-side loader helper that fetches a workbench's
 * threads + works + preferences (forwarding cookies) and seeds them into the
 * React Query cache before the workspace renders. Owns the workbench route's
 * SSR data priming so the sidebar paints with pinned/grouping state intact
 * on a cold refresh (no client-side fetch flicker).
 */

import type { WorkbenchPreferences } from "@meridian/contracts/preferences";
import type { ThreadListItem, Work } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import {
  getWorkbenchPreferences,
  listWorkbenchThreads,
  listWorkbenchWorks,
} from "@/client/api/workbenches-api";

import { workbenchQueryKeys } from "./workbench-query-keys";

export type WorkbenchRouteData = {
  threads: ThreadListItem[] | null;
  works: Work[] | null;
  preferences: WorkbenchPreferences | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logUnexpectedSsrLoadError(error: unknown): void {
  // Expected during optimistic create: the client navigates before POST /api/workbenches.
  if (errorMessage(error) === "Workbench not found") return;

  console.error("Failed to load workbench data during SSR:", error);
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  if (result.status === "fulfilled") return result.value;

  logUnexpectedSsrLoadError(result.reason);
  return null;
}

export async function loadWorkbenchRouteData(workbenchId: string): Promise<WorkbenchRouteData> {
  const init = ssrApiRequestInit();
  const [threads, works, preferences] = await Promise.allSettled([
    listWorkbenchThreads(workbenchId, init),
    listWorkbenchWorks(workbenchId, init),
    getWorkbenchPreferences(workbenchId, init),
  ]);

  return {
    threads: settledValue(threads),
    works: settledValue(works),
    preferences: settledValue(preferences),
  };
}

export function seedWorkbenchRouteData(
  client: QueryClient,
  workbenchId: string,
  data: WorkbenchRouteData,
): void {
  if (data.threads !== null) {
    client.setQueryData(workbenchQueryKeys.threads(workbenchId), data.threads);
  }
  if (data.works !== null) {
    client.setQueryData(workbenchQueryKeys.works(workbenchId), data.works);
  }
  if (data.preferences !== null) {
    client.setQueryData(workbenchQueryKeys.preferences(workbenchId), data.preferences);
  }
}
