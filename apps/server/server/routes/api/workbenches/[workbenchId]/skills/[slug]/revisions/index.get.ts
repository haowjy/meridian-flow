/** GET /api/workbenches/[workbenchId]/skills/[slug]/revisions */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import { handleListSkillDefinitionRevisionsRequest } from "../../../../../../../lib/workbench-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";

  const response = await handleListSkillDefinitionRevisionsRequest(
    { workbenchRepo: app.workbenchRepo, packageRepository: app.packageRepository },
    { workbenchId, userId: user.userId, slug },
  );

  return serializeTransport(response);
});
