/** GET /api/threads/[threadId]/debug/model-requests — dev-only model-request capture for thread owners. */
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleGetModelRequestDebugRecords } from "../../../../../lib/model-request-debug-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const query = getQuery(event);
  const turnId = typeof query.turnId === "string" ? query.turnId : undefined;
  const gatewayCallId = typeof query.gatewayCallId === "string" ? query.gatewayCallId : undefined;
  const rawIteration = query.iteration;
  const iteration = typeof rawIteration === "string" ? Number(rawIteration) : undefined;
  if (
    rawIteration !== undefined &&
    (iteration === undefined || !Number.isInteger(iteration) || iteration < 0)
  ) {
    throw createError({ statusCode: 400, message: "iteration must be a non-negative integer" });
  }
  const latest = query.latest === "1" || query.latest === "true";

  return handleGetModelRequestDebugRecords(
    {
      repos: app.repos,
      projectRepo: app.projectRepo,
      modelRequestDebug: app.modelRequestDebug,
    },
    { threadId, userId: user.userId, turnId, gatewayCallId, iteration, latest },
  );
});
