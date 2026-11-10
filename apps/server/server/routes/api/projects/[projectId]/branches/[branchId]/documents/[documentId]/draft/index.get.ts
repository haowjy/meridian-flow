/** GET addressed draft metadata without opening its collaborative room. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../lib/auth-gate.js";
import {
  handleDraftMetadataRequest,
  selectBranchRouteServices,
} from "../../../../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const itemKey = getQuery(event).itemKey;
  return handleDraftMetadataRequest(selectBranchRouteServices(app), {
    userId: user.userId,
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    branchId: (getRouterParam(event, "branchId") ?? "") as BranchId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    itemKey: typeof itemKey === "string" ? itemKey : "",
  });
});
