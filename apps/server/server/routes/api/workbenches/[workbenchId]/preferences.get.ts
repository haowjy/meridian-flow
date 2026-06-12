/** GET /api/workbenches/[workbenchId]/preferences: returns the authenticated user's persisted thread-list preferences for an owned workbench. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { handleGetWorkbenchPreferencesRequest } from "../../../../lib/workbench-preferences-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";

  const response = await handleGetWorkbenchPreferencesRequest(
    {
      workbenchRepo: app.workbenchRepo,
      preferences: app.preferences,
      packageRepository: app.packageRepository,
    },
    { workbenchId, userId: user.userId },
  );

  return serializeTransport(response);
});
