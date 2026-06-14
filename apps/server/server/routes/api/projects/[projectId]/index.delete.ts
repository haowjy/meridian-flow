/** DELETE /api/projects/[projectId]: soft-deletes a project (idempotent). Depends on the auth gate, project ownership, and project repository. */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";

  const project = await requireProjectOwner({ projects: projectRepo }, projectId, userId, {
    includeSoftDeleted: true,
  });
  if (!project.deletedAt) {
    await projectRepo.softDelete(projectId);
  }

  setResponseStatus(event, 204);
});
