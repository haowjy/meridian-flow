/** GET /api/workbenches/[workbenchId]/agents: selectable agent catalog for an owned workbench. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleGetWorkbenchAgentsRequest } from "../../../../../lib/workbench-agents-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";

  const response = await handleGetWorkbenchAgentsRequest(
    { workbenchRepo: app.workbenchRepo, packageRepository: app.packageRepository },
    { workbenchId, userId: user.userId },
  );

  return serializeTransport(response);
});
