/** GET /api/projects/[projectId]: returns a single owned project. Depends on the auth gate, project ownership, and project repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";

  const project = await requireProjectOwner({ projects: projectRepo }, projectId, userId);
  await app.seedDefaultPackagesForProject(project.id);
  return serializeTransport(project);
});
