/** GET /api/threads/[threadId]/debug/model-requests — dev-only model-request capture for thread owners. */
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleGetModelRequestDebugRecords } from "../../../../../lib/model-request-debug-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const query = getQuery(event);
  const turnId = typeof query.turnId === "string" ? query.turnId : undefined;

  return handleGetModelRequestDebugRecords(
    {
      repos: app.repos,
      projectRepo: app.projectRepo,
      modelRequestDebug: app.modelRequestDebug,
    },
    { threadId, userId: user.userId, turnId },
  );
});
