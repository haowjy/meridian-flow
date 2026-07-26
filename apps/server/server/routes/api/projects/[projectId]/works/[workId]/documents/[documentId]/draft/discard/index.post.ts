/** Discard a Work draft or one server-owned Discard class. */
import type { DraftDiscardRequest } from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleDiscardWorkDraftRequest,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<Partial<DraftDiscardRequest>>(event)) ?? {};
  const draftId = typeof body.draftId === "string" ? body.draftId : undefined;
  if (!draftId) {
    throw createError({ statusCode: 400, message: "draftId is required" });
  }
  return handleDiscardWorkDraftRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId,
    userId: user.userId,
    operationIds: Array.isArray(body.operationIds)
      ? body.operationIds.filter(
          (operationId): operationId is string => typeof operationId === "string",
        )
      : undefined,
  });
});
