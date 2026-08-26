/** Serialized thread-trash transition and its atomic Work-context obligation. */
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { ProjectRepository } from "../../projects/index.js";
import type { ThreadRepositories, WorkContextDeliveryRepository } from "../ports/repositories.js";

export class ThreadTrashUnavailableError extends Error {
  constructor(readonly threadId: ThreadId) {
    super("Thread not found");
    this.name = "ThreadTrashUnavailableError";
  }
}

export interface RestoreThreadFromTrashTransition {
  thread: Thread;
  changed: boolean;
}

interface RestoreThreadFromTrashDeps {
  repos: Pick<ThreadRepositories, "threads" | "transaction">;
  projects: Pick<ProjectRepository, "findById">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
}

/** Applies the owned restore after locking the including-deleted lifecycle row. */
export async function restoreThreadFromTrashTransition(
  deps: RestoreThreadFromTrashDeps,
  input: { threadId: ThreadId; userId: UserId; expectedProjectId: ProjectId },
): Promise<RestoreThreadFromTrashTransition> {
  return deps.repos.transaction(async () => {
    const before = await deps.repos.threads.lockByIdIncludingDeleted(input.threadId);
    if (!before || before.projectId !== input.expectedProjectId || before.userId !== input.userId) {
      throw new ThreadTrashUnavailableError(input.threadId);
    }
    const project = await deps.projects.findById(before.projectId);
    if (!project || project.deletedAt || project.userId !== input.userId) {
      throw new ThreadTrashUnavailableError(input.threadId);
    }
    if (!before.deletedAt) return { thread: before, changed: false };

    const thread = await deps.repos.threads.restore(input.threadId);
    await deps.obligations.enqueueThread(input.threadId);
    return { thread, changed: true };
  });
}
