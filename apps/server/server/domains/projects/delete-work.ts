/** Soft-delete and restore commands that refresh model-visible Work lists once. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { WorkDeleteRetryError, type WorkRepository } from "./ports/work-repository.js";
import type { WorkContextNotices } from "./work-context-notices.js";

type Deps = {
  works: WorkRepository;
  workContextNotices: Pick<WorkContextNotices, "projectChanged">;
  stopThreadRun?: (threadId: ThreadId) => Promise<void>;
};

export type DeleteWorkTransition = { before: Work | null; after: Work | null; changed: boolean };

export async function deleteWork(deps: Deps, workId: WorkId): Promise<void> {
  await deleteWorkTransition(deps, workId);
}

export async function deleteWorkTransition(
  deps: Deps,
  workId: WorkId,
): Promise<DeleteWorkTransition> {
  let threadIds: ThreadId[] = [];
  let transition: DeleteWorkTransition | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      transition = await deps.works.transaction(async () => {
        const deletion = await deps.works.softDelete(workId);
        const { before, after } = deletion;
        threadIds = deletion.threadIds;
        const changed = !!after?.deletedAt && !before?.deletedAt;
        if (changed && before) await deps.workContextNotices.projectChanged(before.projectId);
        return { before, after, changed };
      });
      break;
    } catch (error) {
      if (!(error instanceof WorkDeleteRetryError) || attempt === 4) throw error;
    }
  }
  if (!transition) throw new Error("Work deletion did not complete");
  if (transition.changed && deps.stopThreadRun) {
    await Promise.all(threadIds.map(deps.stopThreadRun));
  }
  return transition;
}

export async function restoreWork(deps: Deps, workId: WorkId): Promise<Work> {
  return deps.works.transaction(async () => {
    const restoration = await deps.works.restore(workId);
    if (restoration.changed) {
      await deps.workContextNotices.projectChanged(restoration.after.projectId);
    }
    return restoration.after;
  });
}
