/** PATCH /api/projects/[projectId]: updates an owned project's mutable fields. Depends on the auth gate, project ownership, and project repository. */
import { serializeTransport, type UpdateProjectRequest } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";
  const body = (await readBody<UpdateProjectRequest>(event)) ?? {};

  await requireProjectOwner({ projects: projectRepo }, projectId, userId);
  const project = await projectRepo.update(projectId, {
    title: body.title,
    description: body.description,
  });

  return serializeTransport(project);
});
