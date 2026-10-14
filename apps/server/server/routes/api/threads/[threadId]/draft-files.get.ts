/** GET /api/threads/:threadId/draft-files: the chat strip's collapsed list, SQL only (no decode, no projection). */
import type { ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  handleThreadDraftFilesRequest,
  selectDraftRouteServices,
} from "../../../../lib/draft-review-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleThreadDraftFilesRequest(
    {
      ...selectDraftRouteServices(app),
      threads: app.repos.threads,
      threadWorks: app.repos.threadWorks,
    },
    { threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId, userId: user.userId },
  );
});
