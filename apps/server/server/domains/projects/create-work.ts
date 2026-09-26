/** Creates a Work and enqueues project context delivery in one transaction. */
import type { Work } from "@meridian/contracts/works";
import type { CreateWorkInput, WorkRepository } from "./ports/work-repository.js";
import type { WorkContextNotices } from "./work-context-notices.js";

export async function createWork(
  deps: {
    works: WorkRepository;
    workContextNotices: Pick<WorkContextNotices, "projectChanged">;
  },
  input: CreateWorkInput,
): Promise<Work> {
  return deps.works.transaction(async () => {
    const work = await deps.works.create(input);
    await deps.workContextNotices.projectChanged(work.projectId);
    return work;
  });
}
