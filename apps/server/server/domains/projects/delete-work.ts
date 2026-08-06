/** Soft-delete and restore commands that refresh model-visible Work lists once. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { WorkRepository } from "./ports/work-repository.js";
import type { WorkContextUpdates } from "./work-context-updates.js";

type Deps = {
  works: WorkRepository;
  contextUpdates: Pick<WorkContextUpdates, "projectChanged">;
};

export async function deleteWork(deps: Deps, workId: WorkId): Promise<void> {
  const work = await deps.works.findById(workId);
  if (!work || work.deletedAt) return;
  await deps.works.softDelete(workId);
  await deps.contextUpdates.projectChanged(work.projectId);
}

export async function restoreWork(deps: Deps, workId: WorkId): Promise<Work> {
  const before = await deps.works.findById(workId);
  if (!before) throw new Error(`Work not found: ${workId}`);
  const work = await deps.works.restore(workId);
  if (before.deletedAt) await deps.contextUpdates.projectChanged(work.projectId);
  return work;
}
