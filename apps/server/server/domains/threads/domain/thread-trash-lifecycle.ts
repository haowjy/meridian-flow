/** Owner-aware, serialized thread-trash desired-state transition. */
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type {
  ProjectRepository,
  ProjectWorkAuthorityResolver,
  WorkContextNotices,
  WorkRepository,
} from "../../projects/index.js";
import type { ThreadRepositories } from "../ports/repositories.js";

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
  works: Pick<WorkRepository, "findNoWork">;
  workContextNotices: Pick<WorkContextNotices, "threadChanged">;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

/** Locks, authorizes, and applies one owned thread-trash desired state. */
export async function transitionThreadTrash(
  deps: TransitionThreadTrashDeps,
  input: { threadId: ThreadId; userId: UserId; target: ThreadTrashState },
): Promise<ThreadTrashTransition> {
  if (input.target === "visible") {
    const projectId = await deps.repos.threads.findProjectIdByIdIncludingDeleted(input.threadId);
    if (!projectId) throw new ThreadTrashUnavailableError(input.threadId);
    const noWork = await deps.works.findNoWork(projectId);
    if (!noWork) throw new Error("No Work is missing for this project");
    return deps.repos.transaction(async () => {
      // Include the possible fallback before locking Works so both ids are acquired in order.
      const before = await deps.repos.threads.lockByIdIncludingDeleted(input.threadId, [noWork.id]);
      if (!before || before.userId !== input.userId) {
        throw new ThreadTrashUnavailableError(input.threadId);
      }
      const project = await deps.projects.findById(before.projectId);
      if (!project || project.deletedAt || project.userId !== input.userId) {
        throw new ThreadTrashUnavailableError(input.threadId);
      }
      if (!before.deletedAt) return { thread: before, changed: false };
      const primary = await deps.repos.threadWorks.findPrimary(input.threadId);
      const availableAuthority = primary
        ? await deps.workAuthorityResolver.lockById(before.projectId, primary.workId)
        : null;
      if (!availableAuthority) {
        await deps.workAuthorityResolver.lockById(before.projectId, noWork.id);
        await deps.repos.threadWorks.rebindPrimaryForRestore(input.threadId, noWork.id);
      }
      const thread = await deps.repos.threads.setTrashState(input.threadId, "visible");
      await deps.workContextNotices.threadChanged(input.threadId);
      return { thread, changed: true };
    });
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
