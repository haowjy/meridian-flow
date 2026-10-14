/** GET /api/projects/:projectId/works/:workId/documents/:documentId/draft/attribution?itemKey=: the chat-name hint's edit parts. */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleDraftAttributionRequest,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const itemKey = getQuery(event).itemKey;
  if (typeof itemKey !== "string" || !itemKey)
    throw createError({ statusCode: 400, message: "itemKey is required" });
  return handleDraftAttributionRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    userId: user.userId,
    itemKey,
  });
});
