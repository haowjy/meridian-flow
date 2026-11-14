/** POST /api/projects/:projectId/branches/:branchId/undo-discard: Take back a Discard: fresh pending copies of what it settled. */
import type { BranchId } from "@meridian/contracts";
import type { ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handleUndoDiscardRequest,
  selectBranchRouteServices,
} from "../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleUndoDiscardRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    branchId: (getRouterParam(event, "branchId") ?? "") as BranchId,
    userId: user.userId,
    request: await readBody(event),
  });
});
