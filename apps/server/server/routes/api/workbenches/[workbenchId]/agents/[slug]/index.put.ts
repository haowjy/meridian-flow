/** PUT /api/workbenches/[workbenchId]/agents/[slug]: save agent definition and append a revision. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handlePutAgentDefinitionRequest,
  parseUpdateAgentDefinitionRequest,
} from "../../../../../../lib/workbench-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";
  const body = parseUpdateAgentDefinitionRequest(await readBody(event));

  const response = await handlePutAgentDefinitionRequest(
    { workbenchRepo: app.workbenchRepo, packageRepository: app.packageRepository },
    { workbenchId, userId: user.userId, slug, body },
  );

  return serializeTransport(response);
});
