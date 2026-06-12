/** PUT /api/workbenches/[workbenchId]/skills/[slug]: save skill definition and append a revision. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handlePutSkillDefinitionRequest,
  parseUpdateSkillDefinitionRequest,
} from "../../../../../../lib/workbench-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";
  const body = parseUpdateSkillDefinitionRequest(await readBody(event));

  const response = await handlePutSkillDefinitionRequest(
    { workbenchRepo: app.workbenchRepo, packageRepository: app.packageRepository },
    { workbenchId, userId: user.userId, slug, body },
  );

  return serializeTransport(response);
});
