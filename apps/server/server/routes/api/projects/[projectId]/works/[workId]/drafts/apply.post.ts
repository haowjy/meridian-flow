/** POST /api/projects/:projectId/works/:workId/drafts/apply: Apply all, one server command. */
import { DraftApplyAllRequestSchema } from "@meridian/contracts/drafts";
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import {
  handleApplyAllWorkDraftRequest,
  selectDraftRouteServices,
} from "../../../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const request = DraftApplyAllRequestSchema.safeParse(await readBody(event));
  if (!request.success)
    throw createError({ statusCode: 400, message: "Invalid Apply all request" });
  const projectId = (getRouterParam(event, "projectId") ?? "") as ProjectId;
  const result = await handleApplyAllWorkDraftRequest(selectDraftRouteServices(app), {
    projectId,
    workId: (getRouterParam(event, "workId") ?? "") as WorkId,
    userId: user.userId,
    request: request.data,
    signal: event.req.signal,
  });
  if (result.status === "pending") event.res.status = 202;
  return result;
});
