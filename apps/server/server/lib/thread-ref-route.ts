/**
 * Route core for GET /api/projects/:projectId/threads/by-ref/:ref — resolves a live
 * `cN`/`pN` handle within a project the caller owns. Malformed and unknown refs are 404.
 */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { parseThreadRef, type Thread } from "@meridian/contracts/threads";
import { createError } from "nitro/h3";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";
import type { ThreadRepository } from "../domains/threads/index.js";

export async function handleGetThreadByRef(
  deps: {
    projectRepo: Pick<ProjectRepository, "findById">;
    threads: Pick<ThreadRepository, "findLiveByProjectRef">;
  },
  input: { projectId: string; userId: UserId; ref: string },
): Promise<Thread> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const notFound = () =>
    createError({ statusCode: 404, message: `No live thread ${input.ref} in this project` });
  if (!parseThreadRef(input.ref)) throw notFound();
  const thread = await deps.threads.findLiveByProjectRef(input.projectId as ProjectId, input.ref);
  if (!thread) throw notFound();
  return thread;
}
