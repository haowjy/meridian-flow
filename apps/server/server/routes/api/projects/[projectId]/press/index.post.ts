/** POST /api/projects/:projectId/press: Apply or Discard a draft's changes, or restore a Draft turn, as one command. */
import type { ProjectId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handlePressRequest,
  selectDraftRouteServices,
} from "../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handlePressRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    userId: user.userId,
    request: await readBody(event),
  });
});
