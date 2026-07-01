/** POST /api/threads/:threadId/documents/:documentId/draft/undo-reject: reactivate a discarded AI draft. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import {
  handleDraftUndoRejectRequest,
  selectDraftRouteServices,
} from "../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<{ draftId?: string }>(event)) ?? {};
  return handleDraftUndoRejectRequest(selectDraftRouteServices(app), {
    threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId: typeof body.draftId === "string" ? body.draftId : "",
    userId: user.userId,
  });
});
