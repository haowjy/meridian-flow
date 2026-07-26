/** GET /api/projects/:projectId/works/:workId/documents/:documentId/draft: live-vs-draft preview. */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../lib/auth-gate.js";
import {
  handleWorkDraftPreviewRequest,
  selectDraftRouteServices,
} from "../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const query = getQuery(event);
  const draftId = typeof query.draftId === "string" ? query.draftId : undefined;
  if (!draftId) throw createError({ statusCode: 400, message: "draftId is required" });
  return handleWorkDraftPreviewRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId,
    userId: user.userId,
  });
});
