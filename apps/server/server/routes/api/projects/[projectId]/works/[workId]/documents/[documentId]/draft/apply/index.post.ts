/** Apply one document of the Work's draft: 200 applied, 409 held or stale. */
import { DraftApplyTokensSchema } from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleApplyWorkDraftRequest,
  selectDraftRouteServices,
} from "../../../../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<Record<string, unknown>>(event)) ?? {};
  const draftId = typeof body.draftId === "string" ? body.draftId : undefined;
  if (!draftId) {
    throw createError({ statusCode: 400, message: "draftId is required" });
  }
  const tokens = DraftApplyTokensSchema.safeParse(body);
  if (!tokens.success) throw createError({ statusCode: 400, message: "Invalid Apply tokens" });
  const projectId = (getRouterParam(event, "projectId") ?? "") as ProjectId;
  const result = await handleApplyWorkDraftRequest(selectDraftRouteServices(app), {
    projectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    draftId,
    userId: user.userId,
    tokens: tokens.data,
    signal: event.req.signal,
  });
  event.res.status = result.httpStatus;
  return result.body;
});
