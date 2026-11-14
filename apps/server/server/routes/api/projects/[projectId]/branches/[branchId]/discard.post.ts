/** POST /api/projects/:projectId/branches/:branchId/discard: Discard all, or a selection, as one command. */

import type { BranchId } from "@meridian/contracts";
import { BranchDiscardRequestSchema } from "@meridian/contracts/branches";
import type { ProjectId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handleDiscardBranchRequest,
  selectBranchRouteServices,
} from "../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const request = BranchDiscardRequestSchema.safeParse(await readBody(event));
  if (!request.success) {
    throw createError({ statusCode: 400, message: "Invalid Discard request" });
  }
  const result = await handleDiscardBranchRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    branchId: (getRouterParam(event, "branchId") ?? "") as BranchId,
    userId: user.userId,
    request: request.data,
  });
  event.res.status = result.httpStatus;
  return result.body;
});
