/** POST /api/projects/:projectId/press/undo: Take back one press, text and tree (suggestion mode). */
import type { ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handlePressUndoRequest,
  selectBranchRouteServices,
} from "../../../../../lib/branch-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handlePressUndoRequest(selectBranchRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    userId: user.userId,
    request: await readBody(event),
  });
});
