/** GET /api/projects/:projectId/works/:workId/documents/:documentId/draft/journal: immutable Yjs journal bytes for operation discard. */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleWorkDraftJournalRequest,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const query = getQuery(event);
  const draftId = typeof query.draftId === "string" ? query.draftId : "";
  const revisionToken = parseRevisionToken(query.revisionToken);
  if (!draftId || revisionToken === null) {
    throw createError({ statusCode: 400, message: "draftId and revisionToken are required" });
  }
  return handleWorkDraftJournalRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
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
