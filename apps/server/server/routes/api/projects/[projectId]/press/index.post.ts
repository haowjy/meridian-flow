/** POST /api/projects/:projectId/press: Apply or Discard a Work's changes as one command (suggestion mode). */
import type { ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handlePressRequest,
  selectBranchRouteServices,
} from "../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handlePressRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    userId: user.userId,
    request: await readBody(event),
  });
});
