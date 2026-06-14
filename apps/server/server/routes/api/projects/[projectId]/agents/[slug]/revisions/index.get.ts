/** GET /api/projects/[projectId]/agents/[slug]/revisions: list immutable agent definition revisions. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import { handleListAgentDefinitionRevisionsRequest } from "../../../../../../../lib/project-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";

  const response = await handleListAgentDefinitionRevisionsRequest(
    { projectRepo: app.projectRepo, packageRepository: app.packageRepository },
    { projectId, userId: user.userId, slug },
  );

  return serializeTransport(response);
});
