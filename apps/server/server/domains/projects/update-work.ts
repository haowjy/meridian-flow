/** Applies Work metadata and lifecycle changes as one atomic command. */

import type { WorkId } from "@meridian/contracts/runtime";
import type { Work, WorkStatus } from "@meridian/contracts/works";
import type { UpdateWorkInput, WorkRepository } from "./ports/work-repository.js";
import type { WorkContextUpdates } from "./work-context-updates.js";

export type UpdateWorkCommandInput = UpdateWorkInput & { status?: WorkStatus };
export type WorkTransition = { before: Work; after: Work; changed: boolean };

export async function updateWork(
  deps: {
    works: WorkRepository;
    contextUpdates: Pick<WorkContextUpdates, "projectChanged">;
  },
  workId: WorkId,
  input: UpdateWorkCommandInput,
): Promise<Work> {
  return (await updateWorkTransition(deps, workId, input)).after;
}

export async function updateWorkTransition(
  deps: {
    works: WorkRepository;
    contextUpdates: Pick<WorkContextUpdates, "projectChanged">;
  },
  workId: WorkId,
  input: UpdateWorkCommandInput,
): Promise<WorkTransition> {
  const result = await deps.works.transaction(async () => {
    const before = await deps.works.lockById(workId);
    if (!before || before.deletedAt) throw new Error(`Work not found: ${workId}`);
    let work = await deps.works.update(workId, {
      name: input.name,
      goal: input.goal,
      description: input.description,
    });
    if (input.status === "archived") work = await deps.works.archive(workId);
    if (input.status === "active") work = await deps.works.unarchive(workId);
    return {
      before,
      after: work,
      changed:
        before.name !== work.name ||
        before.goal !== work.goal ||
        before.description !== work.description ||
        before.status !== work.status,
      contextChanged:
        before.name !== work.name || before.goal !== work.goal || before.status !== work.status,
    };
  });
  if (result.contextChanged) await deps.contextUpdates.projectChanged(result.after.projectId);
  return { before: result.before, after: result.after, changed: result.changed };
}
