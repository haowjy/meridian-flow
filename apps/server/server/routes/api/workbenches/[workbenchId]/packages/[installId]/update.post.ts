/** POST /api/workbenches/[workbenchId]/packages/[installId]/update: apply upstream reconciliation. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleApplyPackageUpdateRequest } from "../../../../../../lib/workbench-package-update-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const installId = getRouterParam(event, "installId") ?? "";

  const response = await handleApplyPackageUpdateRequest(
    {
      workbenchRepo: app.workbenchRepo,
      packageRepository: app.packageRepository,
      marsPackageFetcher: app.marsPackageFetcher,
    },
    { workbenchId, userId: user.userId, installId },
  );

  return serializeTransport(response);
});
