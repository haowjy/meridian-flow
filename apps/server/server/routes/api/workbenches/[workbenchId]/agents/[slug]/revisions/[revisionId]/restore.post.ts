/** POST /api/workbenches/[workbenchId]/agents/[slug]/revisions/[revisionId]/restore */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import { handleRestoreAgentDefinitionRevisionRequest } from "../../../../../../../../lib/workbench-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";
  const revisionId = getRouterParam(event, "revisionId") ?? "";

  const response = await handleRestoreAgentDefinitionRevisionRequest(
    { workbenchRepo: app.workbenchRepo, packageRepository: app.packageRepository },
    { workbenchId, userId: user.userId, slug, revisionId },
  );

  return serializeTransport(response);
});
