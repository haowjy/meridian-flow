/** Apply one frozen click on this document’s draft. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../../lib/auth-gate.js";
import {
  handleApplyClickRequest,
  selectBranchRouteServices,
} from "../../../../../../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const result = await handleApplyClickRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    branchId: (getRouterParam(event, "branchId") ?? "") as BranchId,
    documentId: (getRouterParam(event, "documentId") ?? "") as DocumentId,
    userId: user.userId,
    request: await readBody(event),
  });
  return result;
});
