/** GET /api/projects/[projectId]/works: lists works in an owned project. Depends on the auth gate, project ownership, and work repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo, workRepo } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";

  await requireProjectOwner({ projects: projectRepo }, projectId, userId);
  const works = await workRepo.listByProject(projectId);

  return serializeTransport({ works });
});
