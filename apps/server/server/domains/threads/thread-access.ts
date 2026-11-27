import type { ProjectId } from "@meridian/contracts";
import type { UserId } from "@meridian/contracts/runtime";
import type {
  Thread,
  ThreadAvailabilityCode,
  ThreadAvailabilityDetails,
} from "@meridian/contracts/threads";
import {
  throwHttpInterrupt,
  throwHttpInterruptForStatus,
} from "../../shared/interrupt-boundary.js";
import { parseRequestId } from "../../shared/uuid.js";
import { type ProjectRepository, requireProjectOwner } from "../projects/index.js";
import { threadAvailabilityCode } from "./domain/thread-availability.js";
import {
  type ThreadTrashState,
  type ThreadTrashTransition,
  ThreadTrashUnavailableError,
  transitionThreadTrash,
} from "./domain/thread-trash-lifecycle.js";
import type { ThreadRepository } from "./ports/repositories.js";

function throwThreadAvailability(
  code: ThreadAvailabilityCode,
  userId: UserId,
  projectDeleted = false,
): never {
  throwHttpInterrupt(
    {
      code,
      message: code === "thread_deleted" ? "Thread deleted" : "Thread not found",
      retryable: false,
      source: "system",
      details: {
        authenticatedUserId: userId,
        ...(projectDeleted ? { projectDeleted: true } : {}),
      } satisfies ThreadAvailabilityDetails,
    },
    404,
  );
}

export function throwThreadNotFound(userId: UserId): never {
  throwThreadAvailability("thread_not_found", userId);
}

export function throwThreadDeleted(userId: UserId, projectDeleted = false): never {
  throwThreadAvailability("thread_deleted", userId, projectDeleted);
}

export async function findTrashTarget(
  repos: {
    threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
    projects: Pick<ProjectRepository, "findById">;
  },
  threadId: string,
  userId: UserId,
  projectId: unknown,
): Promise<{ threadId: string; thread: Thread | null; projectId: ProjectId }> {
  const parsedThreadId = parseRequestId(threadId);
  if (!parsedThreadId) {
    throwHttpInterruptForStatus(400, "`threadId` must be a canonical UUID");
  }
  const row = await repos.threads.findByIdIncludingDeleted(parsedThreadId);
  if (!row) {
    const parsedProjectId = parseRequestId(projectId);
    if (!parsedProjectId) {
      throwHttpInterruptForStatus(400, "`projectId` must be a canonical UUID");
    }
    const project = await requireProjectOwner(repos, parsedProjectId, userId, {
      includeSoftDeleted: true,
    });
    return { threadId: parsedThreadId, thread: null, projectId: project.id as ProjectId };
  }
  if (threadAvailabilityCode(row, row.project, userId) === "thread_not_found")
    throwThreadNotFound(userId);
  const { project: _project, ...thread } = row;
  return { threadId: thread.id, thread, projectId: thread.projectId as ProjectId };
}

export async function requireThreadOwner(
  repos: { threads: Pick<ThreadRepository, "findByIdIncludingDeleted"> },
  threadId: string,
  userId: UserId,
  options?: { includeDeleted?: boolean },
): Promise<Thread> {
  const parsedThreadId = parseRequestId(threadId);
  if (!parsedThreadId) {
    throwHttpInterruptForStatus(400, "`threadId` must be a canonical UUID");
  }
  const row = await repos.threads.findByIdIncludingDeleted(parsedThreadId);
  const code = threadAvailabilityCode(row, row?.project, userId);
  if (code === "thread_deleted" && !options?.includeDeleted)
    throwThreadDeleted(userId, !!row?.project?.deletedAt);
  if (code === "thread_not_found" || !row) throwThreadNotFound(userId);
  const { project: _project, ...thread } = row;
  return thread;
}

export type SetOwnedThreadTrashStateDeps = Parameters<typeof transitionThreadTrash>[0];

export async function setOwnedThreadTrashState(
  deps: SetOwnedThreadTrashStateDeps,
  threadId: string,
  userId: UserId,
  target: ThreadTrashState,
): Promise<ThreadTrashTransition> {
  const parsedThreadId = parseRequestId(threadId);
  if (!parsedThreadId) {
    throwHttpInterruptForStatus(400, "`threadId` must be a canonical UUID");
  }
  try {
    return await transitionThreadTrash(deps, { threadId: parsedThreadId, userId, target });
  } catch (cause) {
    if (cause instanceof ThreadTrashUnavailableError) {
      throwThreadNotFound(userId);
    }
    throw cause;
  }
}
