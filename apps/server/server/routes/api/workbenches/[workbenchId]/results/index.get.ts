import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleListWorkbenchResultsRequest } from "../../../../../lib/workbench-results-route.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  return serializeTransport(
    await handleListWorkbenchResultsRequest(
      { workbenchRepo: app.workbenchRepo, results: app.results },
      { workbenchId, userId: user.userId },
    ),
  );
});
