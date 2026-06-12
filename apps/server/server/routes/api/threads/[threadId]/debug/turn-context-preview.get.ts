/** GET /api/threads/[threadId]/debug/turn-context-preview — dev-only next-turn model context preview for thread owners. */
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleGetTurnContextPreview } from "../../../../../lib/turn-context-preview-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";

  return handleGetTurnContextPreview(
    {
      repos: app.repos,
      workbenchRepo: app.workbenchRepo,
      modelRequestDebug: app.modelRequestDebug,
      packageRepository: app.packageRepository,
      toolRegistry: app.toolRegistry,
      toolExecutor: app.toolExecutor,
    },
    { threadId, userId: user.userId },
  );
});
