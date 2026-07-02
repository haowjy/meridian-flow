/** POST /api/threads/:threadId/documents/:documentId/draft/accept: apply a reviewed AI draft to the live document. */
import type { DraftAcceptRequest } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import {
  handleDraftAcceptRequest,
  selectDraftRouteServices,
} from "../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<Partial<DraftAcceptRequest>>(event)) ?? {};
  if (typeof body.draftRevisionToken !== "number") {
    throw createError({ statusCode: 400, message: "draftRevisionToken is required" });
  }

  return handleDraftAcceptRequest(selectDraftRouteServices(app), {
    threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId: typeof body.draftId === "string" ? body.draftId : "",
    userId: user.userId,
    draftRevisionToken: body.draftRevisionToken,
    confirmOverlap: body.confirmOverlap === true,
    confirmedLiveRevisionToken:
      typeof body.confirmedLiveRevisionToken === "number"
        ? body.confirmedLiveRevisionToken
        : undefined,
  });
});
