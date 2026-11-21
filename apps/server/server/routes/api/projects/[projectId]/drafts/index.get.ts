/** GET /api/projects/:projectId/drafts?draft=<id>: a draft's reviewable items. */
import type { ProjectId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handleDraftListRequest,
  selectBranchRouteServices,
} from "../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const draft = getQuery(event).draft;
  if (typeof draft !== "string") throw createError({ statusCode: 400, message: "Missing draft" });
  return handleDraftListRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    draft,
    userId: user.userId,
  });
});
