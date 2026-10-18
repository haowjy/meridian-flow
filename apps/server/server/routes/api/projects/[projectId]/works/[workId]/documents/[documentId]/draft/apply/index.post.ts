/** Apply one item of the Work's draft: 200 applied, 202 pending, 409 held or stale. */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleApplyWorkBranchRequest,
  parseDraftApplyItem,
  selectBranchRouteServices,
} from "../../../../../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const result = await handleApplyWorkBranchRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    userId: user.userId,
    request: parseDraftApplyItem(await readBody(event)),
    signal: event.req.signal,
  });
  event.res.status = result.httpStatus;
  return result.body;
});
