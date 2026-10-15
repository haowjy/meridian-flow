/** POST /api/projects/:projectId/works/:workId/drafts/discard: Discard all, one server command. */
import { DraftDiscardAllRequestSchema } from "@meridian/contracts/drafts";
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import {
  handleDiscardAllWorkDraftRequest,
  selectDraftRouteServices,
} from "../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const request = DraftDiscardAllRequestSchema.safeParse(await readBody(event));
  if (!request.success) {
    throw createError({ statusCode: 400, message: "Invalid Discard all request" });
  }
  const result = await handleDiscardAllWorkDraftRequest(selectDraftRouteServices(app), {
    projectId: (getRouterParam(event, "projectId") ?? "") as ProjectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    userId: user.userId,
    request: request.data,
  });
  event.res.status = result.httpStatus;
  return result.body;
});
