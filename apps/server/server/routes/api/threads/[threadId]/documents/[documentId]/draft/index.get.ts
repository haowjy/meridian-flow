/** GET /api/threads/:threadId/documents/:documentId/draft: authenticated live-vs-draft markdown preview. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import {
  handleDraftPreviewRequest,
  selectDraftRouteServices,
} from "../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleDraftPreviewRequest(selectDraftRouteServices(app), {
    threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId: typeof getQuery(event).draftId === "string" ? getQuery(event).draftId : undefined,
    surface: getQuery(event).surface === "inline" ? "inline" : undefined,
    userId: user.userId,
  });
});
