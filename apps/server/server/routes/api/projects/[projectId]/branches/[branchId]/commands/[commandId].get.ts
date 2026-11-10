/** GET /api/projects/:projectId/branches/:branchId/commands/:commandId: what a command settled as. */
import type { BranchId } from "@meridian/contracts";
import type { ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import {
  handleBranchCommandObservation,
  selectBranchRouteServices,
} from "../../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleBranchCommandObservation(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    branchId: (getRouterParam(event, "branchId") ?? "") as BranchId,
    userId: user.userId,
    commandId: getRouterParam(event, "commandId") ?? "",
  });
});
