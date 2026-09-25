/** Owner-aware, serialized thread-trash desired-state transition. */
import type { ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
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

function isPostgresDeadlock(cause: unknown): boolean {
  for (let current = cause; current && typeof current === "object"; ) {
    if ("code" in current && current.code === "40P01") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
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
      try {
        const transition = await deps.repos.transaction(async () => {
          const availableAuthority = snapshotPrimary
            ? await deps.workAuthorityResolver.lockById(snapshotProjectId, snapshotPrimary.workId)
            : null;
          let replacementWorkId: WorkId | null = null;
          if (!availableAuthority) {
            const noWork = await deps.works.findNoWork(snapshotProjectId);
            if (!noWork) throw new Error("No Work is missing for this project");
            await deps.workAuthorityResolver.lockById(snapshotProjectId, noWork.id);
            replacementWorkId = noWork.id;
          }
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
          if (replacementWorkId) {
            await deps.repos.threadWorks.rebindPrimaryForRestore(input.threadId, replacementWorkId);
          }
          const thread = await deps.repos.threads.setTrashState(input.threadId, "visible");
          await deps.workContextNotices.threadChanged(input.threadId);
          return { thread, changed: true };
        });
        if (transition) return transition;
      } catch (cause) {
        if (isPostgresDeadlock(cause)) continue;
        throw cause;
      }
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
