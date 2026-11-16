/** POST /api/projects/:projectId/drafts/provenance: the authorship evidence of an owner's drafts. */
import type { ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleDraftsProvenance } from "../../../../../lib/draft-provenance-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleDraftsProvenance(app, {
    userId: user.userId,
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    body: await readBody(event),
  });
});
