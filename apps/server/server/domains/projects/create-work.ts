/** Creates a Work. */
import type { Work } from "@meridian/contracts/works";
import type { CreateWorkInput, WorkRepository } from "./ports/work-repository.js";

export async function createWork(
  deps: { works: WorkRepository },
  input: CreateWorkInput,
): Promise<Work> {
  return deps.works.create(input);
}
