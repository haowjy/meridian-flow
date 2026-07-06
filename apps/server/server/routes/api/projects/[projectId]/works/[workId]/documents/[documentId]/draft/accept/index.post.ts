/** POST /api/projects/:projectId/works/:workId/documents/:documentId/draft/accept: apply a reviewed AI draft. */
import type { DraftAcceptRequest } from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleWorkDraftAcceptRequest,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<Partial<DraftAcceptRequest>>(event)) ?? {};
  if (typeof body.draftRevisionToken !== "number") {
    throw createError({ statusCode: 400, message: "draftRevisionToken is required" });
  }
  return handleWorkDraftAcceptRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId:
      typeof body.branchId === "string"
        ? body.branchId
        : typeof body.draftId === "string"
          ? body.draftId
          : "",
    userId: user.userId,
    draftRevisionToken: body.draftRevisionToken,
    operationIds: Array.isArray(body.operationIds)
      ? body.operationIds.filter(
          (operationId): operationId is string => typeof operationId === "string",
        )
      : undefined,
    confirmOverlap: body.confirmOverlap === true,
    confirmedLiveRevisionToken:
      typeof body.confirmedLiveRevisionToken === "number"
        ? body.confirmedLiveRevisionToken
        : undefined,
    confirmedClosureOperationIds: Array.isArray(body.confirmedClosureOperationIds)
      ? body.confirmedClosureOperationIds.filter(
          (operationId): operationId is string => typeof operationId === "string",
        )
      : undefined,
  });
});
