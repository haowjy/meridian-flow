/** Route core for writer-owned Work metadata changes and their coded refusal envelopes. */
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import {
  requireWorkOwner,
  updateWorkTransition,
  type WorkContextNotices,
  WorkNameRequiredError,
  type WorkRepository,
} from "../domains/projects/index.js";
import type { ProjectRepository } from "../domains/projects/ports/project-repository.js";
import { throwWorkMutationHttpError } from "./work-http.js";

export async function updateWorkMetadataForWriter(
  deps: {
    works: WorkRepository;
    projects: ProjectRepository;
    workContextNotices: Pick<WorkContextNotices, "projectChanged">;
  },
  input: { workId: WorkId; userId: UserId; name?: string; goal?: string },
): Promise<Work> {
  try {
    await requireWorkOwner(deps, input.workId, input.userId);
    return (
      await updateWorkTransition(deps, input.workId, {
        name: input.name,
        goal: input.goal,
      })
    ).after;
  } catch (error) {
    if (error instanceof WorkNameRequiredError) {
      throw createError({ statusCode: 400, message: error.message });
    }
    throwWorkMutationHttpError(error);
  }
}
