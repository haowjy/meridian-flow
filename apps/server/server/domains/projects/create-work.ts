/** Creates a Work and enqueues project context delivery in one transaction. */
import type { Work } from "@meridian/contracts/works";
import type { CreateWorkInput, WorkRepository } from "./ports/work-repository.js";
import type { WorkContextDelivery } from "./work-context-delivery.js";

export async function createWork(
  deps: {
    works: WorkRepository;
    workContextDelivery: Pick<WorkContextDelivery, "projectChanged">;
  },
  input: CreateWorkInput,
): Promise<Work> {
  return deps.works.transaction(async () => {
    const work = await deps.works.create(input);
    await deps.workContextDelivery.projectChanged(work.projectId);
    return work;
  });
}
