// @ts-nocheck
/**
 * project-route-data — server-side loader helper that fetches a project's
 * threads + works + preferences (forwarding cookies) and seeds them into the
 * React Query cache before the workspace renders. Owns the project route's
 * SSR data priming so the sidebar paints with pinned/grouping state intact
 * on a cold refresh (no client-side fetch flicker).
 */

import type { ProjectPreferences } from "@meridian/contracts/preferences";
import type { ThreadListItem, Work } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import {
  getProjectPreferences,
  listProjectThreads,
  listProjectWorks,
} from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";

import { projectQueryKeys } from "./project-query-keys";

export type ProjectRouteData = {
  threads: ThreadListItem[] | null;
  works: Work[] | null;
  preferences: ProjectPreferences | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logUnexpectedSsrLoadError(error: unknown): void {
  // Expected during optimistic create: the client navigates before POST /api/projects.
  if (errorMessage(error) === "Project not found") return;

  console.error("Failed to load project data during SSR:", error);
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  if (result.status === "fulfilled") return result.value;

  logUnexpectedSsrLoadError(result.reason);
  return null;
}

export async function loadProjectRouteData(projectId: string): Promise<ProjectRouteData> {
  const init = ssrApiRequestInit();
  const [threads, works, preferences] = await Promise.allSettled([
    listProjectThreads(projectId, init),
    listProjectWorks(projectId, init),
    getProjectPreferences(projectId, init),
  ]);

  return {
    threads: settledValue(threads),
    works: settledValue(works),
    preferences: settledValue(preferences),
  };
}

export function seedProjectRouteData(
  client: QueryClient,
  projectId: string,
  data: ProjectRouteData,
): void {
  if (data.threads !== null) {
    client.setQueryData(projectQueryKeys.threads(projectId), data.threads);
  }
  if (data.works !== null) {
    client.setQueryData(projectQueryKeys.works(projectId), data.works);
  }
  if (data.preferences !== null) {
    client.setQueryData(projectQueryKeys.preferences(projectId), data.preferences);
  }
}
