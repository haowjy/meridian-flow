/** POST /api/projects/:projectId/works/:workId/documents/:documentId/draft/undo-accept: reactivate an accepted AI draft. */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleWorkDraftUndoAcceptRequest,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<{ draftId?: string; writeId?: string }>(event)) ?? {};
  return handleWorkDraftUndoAcceptRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId: typeof body.draftId === "string" ? body.draftId : "",
    userId: user.userId,
    writeId: typeof body.writeId === "string" ? body.writeId : undefined,
  });
});
