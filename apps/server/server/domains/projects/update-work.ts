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
    const requested = {
      name: input.name === undefined ? before.name : input.name.trim(),
      goal: input.goal === undefined ? before.goal : input.goal,
      description: input.description === undefined ? before.description : input.description,
      status: input.status ?? before.status,
    };
    const changed =
      before.name !== requested.name ||
      before.goal !== requested.goal ||
      before.description !== requested.description ||
      before.status !== requested.status;
    const work = changed ? await deps.works.update(workId, requested) : before;
    return {
      before,
      after: work,
      changed,
      contextChanged:
        before.name !== work.name || before.goal !== work.goal || before.status !== work.status,
    };
  });
  if (result.contextChanged) await deps.contextUpdates.projectChanged(result.after.projectId);
  return { before: result.before, after: result.after, changed: result.changed };
}
