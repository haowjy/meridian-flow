/** POST draft/provenance: bounded evidence request for one authenticated room reader. */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../lib/auth-gate.js";
import { handleDraftProvenance } from "../../../../../../../../../lib/draft-provenance-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleDraftProvenance(app, {
    userId: user.userId,
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    body: await readBody(event),
  });
});
