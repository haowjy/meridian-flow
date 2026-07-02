/** GET /api/threads/:threadId/documents/:documentId/draft/journal: immutable Yjs journal bytes for client-side operation discard. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import {
  handleDraftJournalRequest,
  selectDraftRouteServices,
} from "../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const query = getQuery(event);
  const draftId = typeof query.draftId === "string" ? query.draftId : "";
  const revisionToken = parseRevisionToken(query.revisionToken);
  if (!draftId || revisionToken === null) {
    throw createError({ statusCode: 400, message: "draftId and revisionToken are required" });
  }
  return handleDraftJournalRequest(selectDraftRouteServices(app), {
    threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId,
    revisionToken,
    userId: user.userId,
  });
});

function parseRevisionToken(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
