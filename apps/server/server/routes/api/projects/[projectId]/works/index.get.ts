/** GET /api/projects/[projectId]/works: lists works in an owned project. Depends on the auth gate, project ownership, and work repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { WorkStatus } from "@meridian/contracts/works";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireProjectOwner, resolveCurrentWork } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo, workRepo, documentSync, preferences } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";
  const rawStatus = getQuery(event).status;
  if (rawStatus !== undefined && rawStatus !== "active" && rawStatus !== "archived") {
    throw createError({ statusCode: 400, message: "status must be active or archived" });
  }
  const status = (rawStatus ?? "active") as WorkStatus;

  const project = await requireProjectOwner({ projects: projectRepo }, projectId, userId);
  const currentWork = await resolveCurrentWork({ works: workRepo, preferences }, user, project);
  const listedWorks = await workRepo.listByProject(projectId, { status });
  const works = listedWorks.some((work) => work.id === currentWork.id)
    ? listedWorks
    : [currentWork, ...listedWorks];
  const enrichedWorks = await Promise.all(
    works.map(async (work) => ({
      ...work,
      unpushedChangeCount: await documentSync.countUnpushedRowsForWork(work.id),
    })),
  );

  return serializeTransport({ works: enrichedWorks, defaultWorkId: currentWork.id });
});
