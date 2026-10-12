/** Apply the selected dependency-closed Work draft classes. */
import type { DraftApplyChangesRequest } from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleApplyWorkDraftChangesRequest,
  parseDraftApplySelection,
  scheduleDraftCatalogRefresh,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<Partial<DraftApplyChangesRequest>>(event)) ?? {};
  const draftId = typeof body.draftId === "string" ? body.draftId : undefined;
  if (!draftId) {
    throw createError({ statusCode: 400, message: "draftId is required" });
  }
  const selection = parseDraftApplySelection(body);
  const projectId = (getRouterParam(event, "projectId") ?? "") as ProjectId;
  const result = await handleApplyWorkDraftChangesRequest(selectDraftRouteServices(app), {
    projectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId,
    ...selection,
    userId: user.userId,
    signal: event.req.signal,
  });
  if (result.status === "applied")
    scheduleDraftCatalogRefresh(app, projectId, event.waitUntil.bind(event));
  return result;
});
