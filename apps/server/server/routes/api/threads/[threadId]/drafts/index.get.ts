/** GET /api/threads/:threadId/drafts: authenticated active AI drafts for one thread. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handleThreadDraftListRequest,
  selectDraftRouteServices,
} from "../../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleThreadDraftListRequest(selectDraftRouteServices(app), {
    threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
    userId: user.userId,
  });
});
