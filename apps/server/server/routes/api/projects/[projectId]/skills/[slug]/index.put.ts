/** PUT /api/projects/[projectId]/skills/[slug]: save skill definition and append a revision. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handlePutSkillDefinitionRequest,
  parseUpdateSkillDefinitionRequest,
} from "../../../../../../lib/project-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";
  const body = parseUpdateSkillDefinitionRequest(await readBody(event));

  const response = await handlePutSkillDefinitionRequest(
    { projectRepo: app.projectRepo, packageRepository: app.packageRepository },
    { projectId, userId: user.userId, slug, body },
  );

  return serializeTransport(response);
});
