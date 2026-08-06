/** Applies Work metadata and lifecycle changes as one atomic command. */

import type { WorkId } from "@meridian/contracts/runtime";
import type { Work, WorkStatus } from "@meridian/contracts/works";
import type { UpdateWorkInput, WorkRepository } from "./ports/work-repository.js";
import type { WorkContextUpdates } from "./work-context-updates.js";

export type UpdateWorkCommandInput = UpdateWorkInput & { status?: WorkStatus };

export async function updateWork(
  deps: {
    works: WorkRepository;
    contextUpdates: Pick<WorkContextUpdates, "projectChanged">;
  },
  workId: WorkId,
  input: UpdateWorkCommandInput,
): Promise<Work> {
  const result = await deps.works.transaction(async () => {
    const before = await deps.works.findById(workId);
    if (!before) throw new Error(`Work not found: ${workId}`);
    let work = await deps.works.update(workId, {
      name: input.name,
      goal: input.goal,
      description: input.description,
    });
    if (input.status === "archived") work = await deps.works.archive(workId);
    if (input.status === "active") work = await deps.works.unarchive(workId);
    return {
      work,
      contextChanged:
        before.name !== work.name || before.goal !== work.goal || before.status !== work.status,
    };
  });
  if (result.contextChanged) await deps.contextUpdates.projectChanged(result.work.projectId);
  return result.work;
}
