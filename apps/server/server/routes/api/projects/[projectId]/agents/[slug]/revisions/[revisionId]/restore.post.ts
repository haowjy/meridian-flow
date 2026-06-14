/** POST /api/projects/[projectId]/agents/[slug]/revisions/[revisionId]/restore */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import { handleRestoreAgentDefinitionRevisionRequest } from "../../../../../../../../lib/project-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";
  const revisionId = getRouterParam(event, "revisionId") ?? "";

  const response = await handleRestoreAgentDefinitionRevisionRequest(
    { projectRepo: app.projectRepo, packageRepository: app.packageRepository },
    { projectId, userId: user.userId, slug, revisionId },
  );

  return serializeTransport(response);
});
