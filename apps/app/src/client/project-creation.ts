/** Same-tab project creation attempts that let the destination own pending and retry state. */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { createProject, getProject } from "@/client/api/projects-api";

export type ProjectCreationInput = {
  projectId: string;
  accountId: string;
  title: string;
};

type ProjectCreationAttempt = ProjectCreationInput & {
  status: "pending" | "failed";
  promise: Promise<Project>;
};

const attempts = new Map<string, ProjectCreationAttempt>();

function persistedProjectMatches(project: Project, input: ProjectCreationInput): boolean {
  return project.id === input.projectId && project.userId === input.accountId;
}

async function persistProject(input: ProjectCreationInput): Promise<Project> {
  try {
    const project = await createProject({ id: input.projectId, title: input.title });
    if (!persistedProjectMatches(project, input))
      throw new Error("Created project identity mismatch");
    return project;
  } catch (error) {
    const existing = await getProject(input.projectId).catch(() => {
      throw error;
    });
    if (!persistedProjectMatches(existing, input)) throw error;
    return existing;
  }
}

function startAttempt(input: ProjectCreationInput): ProjectCreationAttempt {
  const attempt: ProjectCreationAttempt = {
    ...input,
    status: "pending",
    promise: Promise.resolve(null as never),
  };
  attempt.promise = persistProject(input).catch((error) => {
    if (attempts.get(input.projectId) === attempt) attempt.status = "failed";
    throw error;
  });
  attempts.set(input.projectId, attempt);
  return attempt;
}

export function beginProjectCreation(input: ProjectCreationInput): Promise<Project> {
  const current = attempts.get(input.projectId);
  if (current?.status === "pending") return current.promise;
  return startAttempt(input).promise;
}

/** Waits only for a creation this tab explicitly started; ordinary routes remain server-authorized. */
export async function waitForProjectCreation(projectId: string): Promise<void> {
  const attempt = attempts.get(projectId);
  if (!attempt) return;
  await attempt.promise;
  if (attempts.get(projectId) === attempt) attempts.delete(projectId);
}

export function isProjectCreationPending(projectId: string): boolean {
  return attempts.get(projectId)?.status === "pending";
}

export function projectCreationFailed(projectId: string): boolean {
  return attempts.get(projectId)?.status === "failed";
}

export function retryProjectCreation(projectId: string, accountId: string): Promise<Project> {
  const failed = attempts.get(projectId);
  if (failed?.status !== "failed" || failed.accountId !== accountId)
    throw new Error("Project creation is not retryable");
  return startAttempt({
    projectId: failed.projectId,
    accountId: failed.accountId,
    title: failed.title,
  }).promise;
}
