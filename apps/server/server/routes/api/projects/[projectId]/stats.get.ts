/** GET /api/projects/[projectId]/stats: returns Home destination aggregate stats for an owned project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { computeProjectStats } from "../../../../lib/project-stats.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, projectRepo, workRepo } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";

  await requireProjectOwner({ projects: projectRepo }, projectId, userId);
  const [threads, works] = await Promise.all([
    repos.threads.listByProject(projectId),
    workRepo.listByProject(projectId),
  ]);

  return serializeTransport(computeProjectStats(threads, works));
});
