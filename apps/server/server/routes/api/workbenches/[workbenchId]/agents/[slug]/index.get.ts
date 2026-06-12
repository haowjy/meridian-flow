/** GET /api/workbenches/[workbenchId]/agents/[slug]: load agent definition for the Library editor. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleGetAgentDefinitionRequest } from "../../../../../../lib/workbench-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";

  const response = await handleGetAgentDefinitionRequest(
    { workbenchRepo: app.workbenchRepo, packageRepository: app.packageRepository },
    { workbenchId, userId: user.userId, slug },
  );

  return serializeTransport(response);
});
