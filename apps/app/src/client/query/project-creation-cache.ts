/** Pending project projection used by the authenticated route and project list. */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "./project-query-keys";

export type ProjectCreationRecord = {
  id: string;
  title: string;
  project: Project;
  accountSignal: AbortSignal;
  status: "pending" | "failed";
  error: string | null;
};

/** App routes use the UUID before the server assigns the canonical project slug. */
export type PendingProjectRoute = { id: string; title: string; userId: string };

export function readProjectCreation(client: QueryClient, projectId: string) {
  return client.getQueryData<ProjectCreationRecord>(projectQueryKeys.projectCreation(projectId));
}

export function writeProjectCreation(client: QueryClient, record: ProjectCreationRecord): void {
  client.setQueryData(projectQueryKeys.projectCreation(record.id), record);
}

export function removeProjectCreation(client: QueryClient, projectId: string): void {
  client.removeQueries({ queryKey: projectQueryKeys.projectCreation(projectId), exact: true });
}

export async function createProjectWithRecovery(
  input: { id: string; title: string },
  create: (input: { id: string; title: string }) => Promise<Project>,
  lookup: (id: string) => Promise<Project>,
): Promise<Project> {
  try {
    return await create(input);
  } catch (error) {
    try {
      return await lookup(input.id);
    } catch {
      throw error;
    }
  }
}

export function pendingProject(
  id: string,
  title: string,
  userId: string,
  now = new Date().toISOString(),
): Project {
  return {
    id,
    userId,
    title,
    // These fields are not used for pending app routing; the UUID is canonical.
    slug: "",
    description: null,
    settings: {},
    isPersonal: false,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function pendingProjectRouteState(project: PendingProjectRoute): {
  meridianPendingProject: PendingProjectRoute;
} {
  return { meridianPendingProject: project };
}

export function pendingProjectFromRouteState(
  state: unknown,
  projectId: string,
): PendingProjectRoute | null {
  if (!state || typeof state !== "object") return null;
  const pending = (state as { meridianPendingProject?: unknown }).meridianPendingProject;
  if (!pending || typeof pending !== "object") return null;
  const candidate = pending as { id?: unknown; title?: unknown; userId?: unknown };
  return candidate.id === projectId &&
    typeof candidate.title === "string" &&
    typeof candidate.userId === "string"
    ? {
        id: projectId,
        title: candidate.title,
        userId: candidate.userId,
      }
    : null;
}
