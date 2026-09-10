/** Owner-aware, serialized thread-trash desired-state transition. */
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { ProjectRepository, ProjectWorkAuthorityResolver } from "../../projects/index.js";
import type { ThreadRepositories, WorkContextDeliveryRepository } from "../ports/repositories.js";

export class ThreadTrashUnavailableError extends Error {
  constructor(readonly threadId: ThreadId) {
    super("Thread not found");
    this.name = "ThreadTrashUnavailableError";
  }
}

export type ThreadTrashState = "deleted" | "visible";

export interface ThreadTrashTransition {
  thread: Thread;
  changed: boolean;
}

interface TransitionThreadTrashDeps {
  repos: Pick<ThreadRepositories, "threads" | "threadWorks" | "transaction">;
  projects: Pick<ProjectRepository, "findById">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

/** Locks, authorizes, and applies one owned thread-trash desired state. */
export async function transitionThreadTrash(
  deps: TransitionThreadTrashDeps,
  input: { threadId: ThreadId; userId: UserId; target: ThreadTrashState },
): Promise<ThreadTrashTransition> {
  if (input.target === "visible") {
    for (;;) {
      const snapshotProjectId = await deps.repos.threads.findProjectIdByIdIncludingDeleted(
        input.threadId,
      );
      if (!snapshotProjectId) {
        throw new ThreadTrashUnavailableError(input.threadId);
      }
      const snapshotPrimary = await deps.repos.threadWorks.findPrimary(input.threadId);
      const transition = await deps.repos.transaction(async () => {
        const availableAuthority = snapshotPrimary
          ? await deps.workAuthorityResolver.lockById(snapshotProjectId, snapshotPrimary.workId)
          : null;
        const before = await deps.repos.threads.lockByIdIncludingDeleted(input.threadId);
        if (!before || before.userId !== input.userId) {
          throw new ThreadTrashUnavailableError(input.threadId);
        }
        const primary = await deps.repos.threadWorks.findPrimary(input.threadId);
        if (primary?.workId !== snapshotPrimary?.workId) return null;
        const project = await deps.projects.findById(before.projectId);
        if (!project || project.deletedAt || project.userId !== input.userId) {
          throw new ThreadTrashUnavailableError(input.threadId);
        }
        if (!before.deletedAt) return { thread: before, changed: false };
        if (snapshotPrimary && !availableAuthority) {
          await deps.repos.threadWorks.demotePrimaryForRestore(
            input.threadId,
            snapshotPrimary.workId,
          );
        }
        const thread = await deps.repos.threads.setTrashState(input.threadId, "visible");
        await deps.obligations.enqueueThread(input.threadId);
        return { thread, changed: true };
      });
      if (transition) return transition;
    }
  }
  return deps.repos.transaction(async () => {
    const before = await deps.repos.threads.lockByIdIncludingDeleted(input.threadId);
    if (!before || before.userId !== input.userId) {
      throw new ThreadTrashUnavailableError(input.threadId);
    }
    const project = await deps.projects.findById(before.projectId);
    if (!project || project.deletedAt || project.userId !== input.userId) {
      throw new ThreadTrashUnavailableError(input.threadId);
    }
    const alreadyAtTarget =
      input.target === "deleted" ? Boolean(before.deletedAt) : !before.deletedAt;
    if (alreadyAtTarget) return { thread: before, changed: false };

    const thread = await deps.repos.threads.setTrashState(input.threadId, input.target);
    return { thread, changed: true };
  });
}
