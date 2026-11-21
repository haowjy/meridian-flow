/** POST /api/projects/:projectId/press/undo: Take back one press, text and tree (suggestion mode). */
import type { ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handlePressUndoRequest,
  selectDraftRouteServices,
} from "../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handlePressUndoRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    userId: user.userId,
    request: await readBody(event),
  });
});
