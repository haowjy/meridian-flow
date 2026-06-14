/** GET /api/projects/[projectId]/agents: selectable agent catalog for an owned project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleGetProjectAgentsRequest } from "../../../../../lib/project-agents-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";

  const response = await handleGetProjectAgentsRequest(
    {
      projectRepo: app.projectRepo,
      packageRepository: app.packageRepository,
      seedDefaultPackagesForProject: app.seedDefaultPackagesForProject,
    },
    { projectId, userId: user.userId },
  );

  return serializeTransport(response);
});
