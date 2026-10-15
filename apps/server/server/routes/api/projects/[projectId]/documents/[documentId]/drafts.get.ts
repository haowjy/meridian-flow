/** GET /api/projects/:projectId/documents/:documentId/drafts: active drafts with changes to the document. */
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handleDocumentDraftHintsRequest,
  selectDraftRouteServices,
} from "../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleDocumentDraftHintsRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    userId: user.userId,
  });
});
