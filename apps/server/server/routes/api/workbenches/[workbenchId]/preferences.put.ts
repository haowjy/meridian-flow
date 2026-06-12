/** PUT /api/workbenches/[workbenchId]/preferences: partially upserts the authenticated user's workbench thread-list preferences after workbench ownership is verified. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  handlePutWorkbenchPreferencesRequest,
  parseUpdateWorkbenchPreferencesRequest,
} from "../../../../lib/workbench-preferences-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const body = parseUpdateWorkbenchPreferencesRequest(await readBody(event));

  const response = await handlePutWorkbenchPreferencesRequest(
    {
      workbenchRepo: app.workbenchRepo,
      preferences: app.preferences,
      packageRepository: app.packageRepository,
    },
    { workbenchId, userId: user.userId, body },
  );

  return serializeTransport(response);
});
