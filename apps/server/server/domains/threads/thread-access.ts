/**
 * Thread authorization helper: requireThreadOwner loads a thread and asserts the
 * caller owns it and its parent project is live, throwing 404 otherwise. Owns
 * the thread ownership gate; depends inward on the thread/project repositories.
 */

import type { Project } from "@meridian/contracts/projects";
import type { UserId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { throwHttpInterruptForStatus } from "../../lib/interrupt-boundary.js";
import { parseRequestId } from "../../shared/uuid.js";
import {
  type ProjectRepository,
  requireProjectOwner,
  type WorkContextDelivery,
} from "../projects/index.js";
import {
  restoreThreadFromTrashTransition,
  ThreadTrashUnavailableError,
} from "./domain/thread-trash-lifecycle.js";
import type {
  ThreadRepositories,
  ThreadRepository,
  WorkContextDeliveryRepository,
} from "./ports/repositories.js";

interface ProjectOwnerRepository {
  findById(id: string): Promise<Project | null>;
}

/** Owner gate: 404 for missing, wrong user, deleted thread, or soft-deleted parent project. */
export async function requireThreadOwner(
  repos: { threads: Pick<ThreadRepository, "findById">; projects: ProjectOwnerRepository },
  threadId: string,
  userId: UserId,
): Promise<Thread> {
  const parsedThreadId = parseRequestId(threadId);
  if (!parsedThreadId) {
    throwHttpInterruptForStatus(400, "`threadId` must be a canonical UUID");
  }
  const thread = await repos.threads.findById(parsedThreadId);
  if (!thread || thread.deletedAt) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  const project = await repos.projects.findById(thread.projectId);
  if (!project || project.deletedAt || project.userId !== userId) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  if (thread.userId !== userId) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  return thread;
}

export interface RestoreOwnedThreadFromTrashDeps {
  repos: Pick<ThreadRepositories, "threads" | "transaction">;
  projects: Pick<ProjectRepository, "findById">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
  workContextDelivery: Pick<WorkContextDelivery, "deliverAfterCommit">;
}

/** Authenticated adapter that owns trash authorization and the post-commit wake. */
export async function restoreOwnedThreadFromTrash(
  deps: RestoreOwnedThreadFromTrashDeps,
  threadId: string,
  userId: UserId,
): Promise<Thread> {
  const parsedThreadId = parseRequestId(threadId);
  if (!parsedThreadId) {
    throwHttpInterruptForStatus(400, "`threadId` must be a canonical UUID");
  }
  const projectId = await deps.repos.threads.findProjectIdByIdIncludingDeleted(parsedThreadId);
  if (!projectId) throwHttpInterruptForStatus(404, "Thread not found");
  await requireProjectOwner({ projects: deps.projects }, projectId, userId);

  let transition: Awaited<ReturnType<typeof restoreThreadFromTrashTransition>>;
  try {
    transition = await restoreThreadFromTrashTransition(deps, {
      threadId: parsedThreadId,
      userId,
      expectedProjectId: projectId,
    });
  } catch (cause) {
    if (cause instanceof ThreadTrashUnavailableError) {
      throwHttpInterruptForStatus(404, "Thread not found");
    }
    throw cause;
  }
  if (transition.changed) await deps.workContextDelivery.deliverAfterCommit(parsedThreadId);
  return transition.thread;
}
