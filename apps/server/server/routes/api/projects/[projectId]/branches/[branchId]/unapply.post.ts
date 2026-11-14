/** POST /api/projects/:projectId/branches/:branchId/unapply: Take back one Apply command, text and tree. */
import type { BranchId } from "@meridian/contracts";
import type { ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handleUnapplyClickRequest,
  selectBranchRouteServices,
} from "../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleUnapplyClickRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    branchId: (getRouterParam(event, "branchId") ?? "") as BranchId,
    userId: user.userId,
    request: await readBody(event),
  });
});
