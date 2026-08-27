/** Owner gate for flat Work item routes. */
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import type { ProjectRepository } from "./ports/project-repository.js";
import type { WorkRepository } from "./ports/work-repository.js";
import { requireProjectOwner } from "./project-access.js";

export async function requireWorkOwner(
  repos: { works: WorkRepository; projects: ProjectRepository },
  workId: WorkId,
  userId: UserId,
  options?: { includeSoftDeleted?: boolean },
): Promise<Work> {
  const work = await repos.works.findById(workId);
  if (!work || (!options?.includeSoftDeleted && work.deletedAt)) {
    throw createError({ statusCode: 404, message: "Work not found" });
  }
  await requireProjectOwner(repos, work.projectId, userId);
  return work;
}
