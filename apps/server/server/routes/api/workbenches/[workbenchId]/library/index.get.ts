/** GET /api/workbenches/[workbenchId]/library: full capability inventory for the Library screen. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleGetWorkbenchLibraryRequest } from "../../../../../lib/workbench-library-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";

  const response = await handleGetWorkbenchLibraryRequest(
    { workbenchRepo: app.workbenchRepo, packageRepository: app.packageRepository },
    { workbenchId, userId: user.userId },
  );

  return serializeTransport(response);
});
