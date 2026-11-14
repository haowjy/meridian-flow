/** GET /api/document-commands/:commandId: the stored outcome of a command this account sent. */
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import {
  handleDocumentCommandLookup,
  selectBranchRouteServices,
} from "../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleDocumentCommandLookup(selectBranchRouteServices(app), {
    userId: user.userId,
    commandId: getRouterParam(event, "commandId") ?? "",
  });
});
