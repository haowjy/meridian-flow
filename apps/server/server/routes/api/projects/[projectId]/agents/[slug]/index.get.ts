/** GET /api/projects/[projectId]/agents/[slug]: load agent definition for the Library editor. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleGetAgentDefinitionRequest } from "../../../../../../lib/project-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";

  const response = await handleGetAgentDefinitionRequest(
    { projectRepo: app.projectRepo, packageRepository: app.packageRepository },
    { projectId, userId: user.userId, slug },
  );

  return serializeTransport(response);
});
