import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleWorkbenchResultSignedUrlRequest } from "../../../../../../lib/workbench-results-route.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const resultId = getRouterParam(event, "resultId") ?? "";
  return serializeTransport(
    await handleWorkbenchResultSignedUrlRequest(
      { workbenchRepo: app.workbenchRepo, results: app.results, objectStore: app.objectStore },
      { workbenchId, resultId, userId: user.userId },
    ),
  );
});
