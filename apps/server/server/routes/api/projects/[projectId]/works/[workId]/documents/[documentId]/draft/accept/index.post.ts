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
  const branchId = typeof body.branchId === "string" ? body.branchId : undefined;
  const draftId = typeof body.draftId === "string" ? body.draftId : undefined;
  if (!branchId && !draftId) {
    throw createError({ statusCode: 400, message: "branchId or draftId is required" });
  }
  if (branchId && draftId) {
    throw createError({ statusCode: 400, message: "Send branchId or draftId, not both" });
  }
  const operationIds = Array.isArray(body.operationIds)
    ? body.operationIds.flatMap((operationId) => {
        if (typeof operationId !== "string") return [];
        const normalized = operationId.trim();
        return normalized ? [normalized] : [];
      })
    : [];
  if (operationIds.length === 0) {
    throw createError({ statusCode: 400, message: "operationIds are required" });
  }
  return handleWorkDraftAcceptRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    ...(branchId ? { branchId } : { draftId: draftId as string }),
    userId: user.userId,
    draftRevisionToken: body.draftRevisionToken,
    signal: event.req.signal,
    operationIds,
  });
});
