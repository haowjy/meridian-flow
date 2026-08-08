/** Soft-delete and restore commands that refresh model-visible Work lists once. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { WorkRepository } from "./ports/work-repository.js";
import type { WorkContextUpdates } from "./work-context-updates.js";

type Deps = {
  works: WorkRepository;
  contextUpdates: Pick<WorkContextUpdates, "projectChanged">;
};

export type DeleteWorkTransition = { before: Work | null; after: Work | null; changed: boolean };

export async function deleteWork(deps: Deps, workId: WorkId): Promise<void> {
  await deleteWorkTransition(deps, workId);
}

export async function deleteWorkTransition(
  deps: Deps,
  workId: WorkId,
): Promise<DeleteWorkTransition> {
  const transition = await deps.works.transaction(async () => {
    const before = await deps.works.lockById(workId);
    if (!before || before.deletedAt) return { before, after: before, changed: false };
    await deps.works.softDelete(workId);
    const after = await deps.works.findById(workId);
    return { before, after, changed: !!after?.deletedAt };
  });
  if (transition.changed && transition.before) {
    await deps.contextUpdates.projectChanged(transition.before.projectId);
  }
  return transition;
}

export async function restoreWork(deps: Deps, workId: WorkId): Promise<Work> {
  const before = await deps.works.findById(workId);
  if (!before) throw new Error(`Work not found: ${workId}`);
  const work = await deps.works.restore(workId);
  if (before.deletedAt) await deps.contextUpdates.projectChanged(work.projectId);
  return work;
}
