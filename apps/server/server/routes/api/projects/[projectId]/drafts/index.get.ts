/** GET /api/projects/:projectId/drafts?owner=work:<id>|lineage:<rootId>: an owner's reviewable drafts. */
import type { ProjectId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handleOwnerDraftListRequest,
  selectBranchRouteServices,
} from "../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const owner = getQuery(event).owner;
  if (typeof owner !== "string") throw createError({ statusCode: 400, message: "Missing owner" });
  return handleOwnerDraftListRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    owner,
    userId: user.userId,
  });
});
