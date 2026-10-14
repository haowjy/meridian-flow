/** POST /api/projects/:projectId/works/:workId/drafts/apply: Apply all, one server command. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import {
  handleApplyAllWorkDraftRequest,
  parseDraftApplyAll,
  selectDraftRouteServices,
} from "../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const result = await handleApplyAllWorkDraftRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    userId: user.userId,
    request: parseDraftApplyAll(await readBody(event)),
    signal: event.req.signal,
  });
  event.res.status = result.httpStatus;
  return result.body;
});
