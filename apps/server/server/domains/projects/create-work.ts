/** Creates a Work, normalizing its name and goal by the shared Work metadata rule. */
import { normalizeWorkMetadata, type Work } from "@meridian/contracts/works";
import type { CreateWorkInput, WorkRepository } from "./ports/work-repository.js";
import { WorkNameRequiredError } from "./update-work.js";

export async function createWork(
  deps: { works: WorkRepository },
  input: CreateWorkInput,
): Promise<Work> {
  const normalized = normalizeWorkMetadata({ name: input.name, goal: input.goal ?? null });
  if (!normalized.ok || normalized.value.name === undefined) throw new WorkNameRequiredError();
  return deps.works.create({
    ...input,
    name: normalized.value.name,
    goal: normalized.value.goal ?? null,
  });
}
