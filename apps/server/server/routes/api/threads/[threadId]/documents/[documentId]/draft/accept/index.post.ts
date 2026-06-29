/** POST /api/threads/:threadId/documents/:documentId/draft/accept: apply a reviewed AI draft to the live document. */
import type { DraftAcceptRequest } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import {
  handleDraftAcceptRequest,
  selectDraftRouteServices,
} from "../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<DraftAcceptRequest>(event)) ?? {};
  return handleDraftAcceptRequest(selectDraftRouteServices(app), {
    threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    userId: user.userId,
    confirmOverlap: body.confirmOverlap === true,
  });
});
