import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { ListWorksResponse, ThreadListItem } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { getProject, listProjectThreads, listProjectWorks } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";

import { projectQueryKeys } from "./project-query-keys";
import {
  beginWorksSnapshotRequest,
  seedWorksSnapshot,
  type WorksRequestStart,
} from "./works-projection-acquisition";

export type ProjectRouteData = {
  threads: ThreadListItem[] | null;
  works: ListWorksResponse | null;
  worksStarted: WorksRequestStart;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logUnexpectedSsrLoadError(error: unknown): void {
  if (errorMessage(error) === "Project not found") return;

  console.error("Failed to load project data during SSR:", error);
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  if (result.status === "fulfilled") return result.value;

  logUnexpectedSsrLoadError(result.reason);
  return null;
}

export async function loadProjectEntry(
  projectId: string,
): Promise<{ project: Project; data: ProjectRouteData }> {
  const init = ssrApiRequestInit();
  const [project, data] = await Promise.all([
    getProject(projectId, init),
    loadProjectRouteData(projectId),
  ]);
  return { project, data };
}

export async function loadProjectRouteData(projectId: string): Promise<ProjectRouteData> {
  const init = ssrApiRequestInit();
  const worksStarted = beginWorksSnapshotRequest(projectId);
  const [threads, works] = await Promise.allSettled([
    listProjectThreads(projectId, init),
    listProjectWorks(projectId, init),
  ]);

  return {
    threads: settledValue(threads),
    works: settledValue(works),
    worksStarted,
  };
}

const threadsReadAt = new WeakMap<QueryClient, Map<string, number>>();

export function seedProjectRouteData(
  client: QueryClient,
  projectId: string,
  data: ProjectRouteData,
): void {
  if (data.threads !== null) {
    client.setQueryData(projectQueryKeys.threads(projectId), data.threads);
    const byProject = threadsReadAt.get(client) ?? new Map<string, number>();
    threadsReadAt.set(client, byProject.set(projectId, data.worksStarted.at));
  }
  if (data.works !== null) {
    seedWorksSnapshot(client, data.works, data.worksStarted);
  }
}

export function refreshRouteThreadsSince(client: QueryClient, projectId: string, since: number) {
  const readAt = threadsReadAt.get(client)?.get(projectId);
  if (readAt === undefined || readAt >= since) return;
  threadsReadAt.get(client)?.delete(projectId);
  void client.invalidateQueries(
    { queryKey: projectQueryKeys.threads(projectId), exact: true },
    { cancelRefetch: false },
  );
}
