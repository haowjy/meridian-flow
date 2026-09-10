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
import type { ProjectRepository, WorkContextDelivery } from "../projects/index.js";
import {
  type ThreadTrashState,
  ThreadTrashUnavailableError,
  transitionThreadTrash,
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

export interface SetOwnedThreadTrashStateDeps {
  repos: Pick<ThreadRepositories, "threads" | "threadWorks" | "transaction">;
  projects: Pick<ProjectRepository, "findById">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
  workContextDelivery: Pick<WorkContextDelivery, "deliverAfterCommit">;
  workAuthorityResolver: import("../projects/index.js").ProjectWorkAuthorityResolver;
}

/** Authenticated adapter for the serialized trash command and restore wake. */
export async function setOwnedThreadTrashState(
  deps: SetOwnedThreadTrashStateDeps,
  threadId: string,
  userId: UserId,
  target: ThreadTrashState,
): Promise<Thread> {
  const parsedThreadId = parseRequestId(threadId);
  if (!parsedThreadId) {
    throwHttpInterruptForStatus(400, "`threadId` must be a canonical UUID");
  }
  let transition: Awaited<ReturnType<typeof transitionThreadTrash>>;
  try {
    transition = await transitionThreadTrash(deps, {
      threadId: parsedThreadId,
      userId,
      target,
    });
  } catch (cause) {
    if (cause instanceof ThreadTrashUnavailableError) {
      throwHttpInterruptForStatus(404, "Thread not found");
    }
    throw cause;
  }
  if (transition.changed && target === "visible") {
    await deps.workContextDelivery.deliverAfterCommit(parsedThreadId);
  }
  return transition.thread;
}

export function restoreOwnedThreadFromTrash(
  deps: SetOwnedThreadTrashStateDeps,
  threadId: string,
  userId: UserId,
): Promise<Thread> {
  return setOwnedThreadTrashState(deps, threadId, userId, "visible");
}

export function deleteOwnedThreadToTrash(
  deps: SetOwnedThreadTrashStateDeps,
  threadId: string,
  userId: UserId,
): Promise<Thread> {
  return setOwnedThreadTrashState(deps, threadId, userId, "deleted");
}
