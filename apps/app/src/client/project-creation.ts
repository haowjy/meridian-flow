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
  stopAccountWatch?: () => void;
};

const attempts = new Map<string, ProjectCreationAttempt>();

async function persistProject(input: ProjectCreationInput): Promise<Project> {
  try {
    return await createProject({ id: input.projectId, title: input.title });
  } catch (error) {
    return getProject(input.projectId).catch(() => {
      throw error;
    });
  }
}

function forgetAttempt(attempt: ProjectCreationAttempt): void {
  if (attempts.get(attempt.projectId) !== attempt) return;
  attempts.delete(attempt.projectId);
  attempt.stopAccountWatch?.();
}

function startAttempt(
  input: ProjectCreationInput,
  accountSignal?: AbortSignal,
): ProjectCreationAttempt {
  attempts.get(input.projectId)?.stopAccountWatch?.();
  const attempt: ProjectCreationAttempt = {
    ...input,
    status: "pending",
    promise: Promise.resolve(null as never),
  };
  if (accountSignal) {
    const forget = () => forgetAttempt(attempt);
    accountSignal.addEventListener("abort", forget, { once: true });
    attempt.stopAccountWatch = () => accountSignal.removeEventListener("abort", forget);
  }
  attempt.promise = persistProject(input).catch((error) => {
    attempt.status = "failed";
    throw error;
  });
  attempts.set(input.projectId, attempt);
  if (accountSignal?.aborted) forgetAttempt(attempt);
  return attempt;
}

export function beginProjectCreation(
  input: ProjectCreationInput,
  accountSignal?: AbortSignal,
): Promise<Project> {
  const current = attempts.get(input.projectId);
  return current?.status === "pending"
    ? current.promise
    : startAttempt(input, accountSignal).promise;
}

/** Waits only for a creation this tab explicitly started; ordinary routes remain server-authorized. */
export async function waitForProjectCreation(projectId: string): Promise<void> {
  const attempt = attempts.get(projectId);
  if (!attempt) return;
  await attempt.promise;
  forgetAttempt(attempt);
}

export function isProjectCreationPending(projectId: string, accountId: string): boolean {
  const attempt = attempts.get(projectId);
  return attempt?.accountId === accountId && attempt.status === "pending";
}

export function projectCreationFailed(projectId: string, accountId: string): boolean {
  const attempt = attempts.get(projectId);
  return attempt?.accountId === accountId && attempt.status === "failed";
}

export function retryProjectCreation(
  projectId: string,
  accountId: string,
  accountSignal?: AbortSignal,
): Promise<Project> {
  const failed = attempts.get(projectId);
  if (failed?.status !== "failed" || failed.accountId !== accountId)
    throw new Error("Project creation is not retryable");
  return startAttempt(
    { projectId: failed.projectId, accountId: failed.accountId, title: failed.title },
    accountSignal,
  ).promise;
}
