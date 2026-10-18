/** GET /api/projects/:projectId/works/:workId/branches/commands/:commandId: what a command settled as. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import {
  handleBranchCommandObservation,
  selectBranchRouteServices,
} from "../../../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleBranchCommandObservation(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    userId: user.userId,
    commandId: getRouterParam(event, "commandId") ?? "",
  });
});
