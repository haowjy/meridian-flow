/** GET /api/threads/[threadId]/debug/model-requests — dev-only model-request capture for thread owners. */
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handleGetModelRequestDebugRecords,
  parseModelRequestDebugQuery,
} from "../../../../../lib/model-request-debug-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const selection = parseModelRequestDebugQuery(getQuery(event));

  return handleGetModelRequestDebugRecords(
    {
      repos: app.repos,
      projectRepo: app.projectRepo,
      modelRequestDebug: app.modelRequestDebug,
    },
    { threadId, userId: user.userId, ...selection },
  );
});
