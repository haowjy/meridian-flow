/** GET /api/projects/:projectId/works/:workId/drafts: authenticated reviewable AI drafts for one Work. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import {
  handleWorkDraftListRequest,
  selectDraftRouteServices,
} from "../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleWorkDraftListRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    userId: user.userId,
  });
});
