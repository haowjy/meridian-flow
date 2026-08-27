/** Applies Work metadata and lifecycle changes as one atomic command. */

import type { WorkId } from "@meridian/contracts/runtime";
import type { Work, WorkStatus } from "@meridian/contracts/works";
import type { UpdateWorkInput, WorkRepository } from "./ports/work-repository.js";

export type UpdateWorkCommandInput = UpdateWorkInput & { status?: WorkStatus };

export async function updateWork(
  works: WorkRepository,
  workId: WorkId,
  input: UpdateWorkCommandInput,
): Promise<Work> {
  return works.transaction(async () => {
    let work = await works.update(workId, {
      name: input.name,
      goal: input.goal,
      description: input.description,
    });
    if (input.status === "archived") work = await works.archive(workId);
    if (input.status === "active") work = await works.unarchive(workId);
    return work;
  });
}
