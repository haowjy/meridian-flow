/** GET /api/projects/:projectId/works/:workId/branches: authenticated reviewable AI branches for one Work. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import {
  handleWorkBranchListRequest,
  selectBranchRouteServices,
} from "../../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleWorkBranchListRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    userId: user.userId,
  });
});
