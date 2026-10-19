/** GET addressed draft metadata without opening its collaborative room. */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
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
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    itemKey: typeof itemKey === "string" ? itemKey : "",
  });
});
