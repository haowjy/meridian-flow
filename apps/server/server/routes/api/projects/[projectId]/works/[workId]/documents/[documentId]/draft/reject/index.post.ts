/** POST /api/projects/:projectId/works/:workId/documents/:documentId/draft/reject: discard an AI draft. */
import type { DraftRejectRequest } from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleWorkDraftRejectRequest,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<Partial<DraftRejectRequest>>(event)) ?? {};
  const branchId = typeof body.branchId === "string" ? body.branchId : undefined;
  const draftId = typeof body.draftId === "string" ? body.draftId : undefined;
  if (!branchId && !draftId) {
    throw createError({ statusCode: 400, message: "branchId or draftId is required" });
  }
  if (branchId && draftId) {
    throw createError({ statusCode: 400, message: "Send branchId or draftId, not both" });
  }
  return handleWorkDraftRejectRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    ...(branchId ? { branchId } : { draftId: draftId as string }),
    userId: user.userId,
    operationIds: Array.isArray(body.operationIds)
      ? body.operationIds.filter(
          (operationId): operationId is string => typeof operationId === "string",
        )
      : undefined,
  });
});
