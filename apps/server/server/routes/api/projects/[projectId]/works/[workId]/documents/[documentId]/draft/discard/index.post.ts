/** Discard a Work draft or one server-owned Discard class. */
import type { DraftDiscardRequest } from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleDiscardWorkDraftRequest,
  scheduleDraftCatalogRefresh,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<Partial<DraftDiscardRequest>>(event)) ?? {};
  const draftId = typeof body.draftId === "string" ? body.draftId : undefined;
  if (!draftId) {
    throw createError({ statusCode: 400, message: "draftId is required" });
  }
  const projectId = (getRouterParam(event, "projectId") ?? "") as ProjectId;
  const result = await handleDiscardWorkDraftRequest(selectDraftRouteServices(app), {
    projectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId,
    userId: user.userId,
    ...("operationIds" in body ? { operationIds: body.operationIds } : {}),
    ...("liveRevisionToken" in body ? { liveRevisionToken: body.liveRevisionToken } : {}),
    ...("draftRevisionToken" in body ? { draftRevisionToken: body.draftRevisionToken } : {}),
  });
  scheduleDraftCatalogRefresh(app, projectId, event.waitUntil.bind(event));
  return result;
});
