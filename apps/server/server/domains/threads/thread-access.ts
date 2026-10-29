/**
 * HTTP thread ownership and attested availability errors. Deleted rows stay
 * concealed from foreign users; full owners receive a distinct deletion proof.
 */

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
import type { ProjectRepository, WorkContextNotices } from "../projects/index.js";
import { threadAvailabilityCode } from "./domain/thread-availability.js";
import {
  type ThreadTrashState,
  ThreadTrashUnavailableError,
  transitionThreadTrash,
} from "./domain/thread-trash-lifecycle.js";
import type { ThreadRepositories, ThreadRepository } from "./ports/repositories.js";

/** Shared HTTP proof for both repository and runtime owner gates. */
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

/** Owner gate: classify ownership before deletion, including the parent project. */
export async function requireThreadOwner(
  repos: { threads: Pick<ThreadRepository, "findByIdIncludingDeleted"> },
  threadId: string,
  userId: UserId,
): Promise<Thread> {
  const parsedThreadId = parseRequestId(threadId);
  if (!parsedThreadId) {
    throwHttpInterruptForStatus(400, "`threadId` must be a canonical UUID");
  }
  const row = await repos.threads.findByIdIncludingDeleted(parsedThreadId);
  const code = threadAvailabilityCode(row, row?.project, userId);
  if (code === "thread_deleted") throwThreadDeleted(userId, !!row?.project?.deletedAt);
  if (code === "thread_not_found" || !row) throwThreadNotFound(userId);
  const { project: _project, ...thread } = row;
  return thread;
}

export interface SetOwnedThreadTrashStateDeps {
  repos: Pick<ThreadRepositories, "threads" | "threadWorks" | "transaction">;
  projects: Pick<ProjectRepository, "findById">;
  workContextNotices: Pick<WorkContextNotices, "threadChanged" | "materializeIdle">;
  workAuthorityResolver: import("../projects/index.js").ProjectWorkAuthorityResolver;
  works: Pick<import("../projects/index.js").WorkRepository, "findById" | "findNoWork">;
  /** `threadIds` must be parents first (`parentsFirst`). */
  stopThreads(threadIds: readonly import("@meridian/contracts/runtime").ThreadId[]): Promise<void>;
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
      throwThreadNotFound(userId);
    }
    throw cause;
  }
  if (transition.changed && target === "visible") {
    await deps.workContextNotices.materializeIdle(parsedThreadId);
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
