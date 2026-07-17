/** GET /api/projects/[projectId]/works: lists works in an owned project. Depends on the auth gate, project ownership, and work repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner, resolveDefaultWork } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo, workRepo, documentSync } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";

  const project = await requireProjectOwner({ projects: projectRepo }, projectId, userId);
  const defaultWorkId = await resolveDefaultWork({ works: workRepo }, user, project);
  const works = await workRepo.listByProject(projectId);
  const enrichedWorks = await Promise.all(
    works.map(async (work) => ({
      ...work,
      unpushedChangeCount: await documentSync.countUnpushedRowsForWork(work.id),
    })),
  );

  return serializeTransport({ works: enrichedWorks, defaultWorkId });
});
