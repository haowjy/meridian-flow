/** Creates a Work and selects it for the creator in one transaction. */
import type { UserId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { ProjectPreferencesRepository } from "../preferences/index.js";
import type { CreateWorkInput, WorkRepository } from "./ports/work-repository.js";

export async function createWork(
  deps: {
    works: WorkRepository;
    preferences: ProjectPreferencesRepository;
  },
  userId: UserId,
  input: CreateWorkInput,
): Promise<Work> {
  return deps.works.transaction(async () => {
    const work = await deps.works.create(input);
    await deps.preferences.setCurrentWorkId(userId, input.projectId, work.id);
    return work;
  });
}
