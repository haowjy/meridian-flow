/** PUT /api/projects/[projectId]/agents/[slug]: save agent definition and append a revision. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handlePutAgentDefinitionRequest,
  parseUpdateAgentDefinitionRequest,
} from "../../../../../../lib/project-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";
  const body = parseUpdateAgentDefinitionRequest(await readBody(event));

  const response = await handlePutAgentDefinitionRequest(
    { projectRepo: app.projectRepo, packageRepository: app.packageRepository },
    { projectId, userId: user.userId, slug, body },
  );

  return serializeTransport(response);
});
