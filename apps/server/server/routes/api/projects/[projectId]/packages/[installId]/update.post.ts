/** POST /api/projects/[projectId]/packages/[installId]/update: apply upstream reconciliation. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleApplyPackageUpdateRequest } from "../../../../../../lib/project-package-update-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const installId = getRouterParam(event, "installId") ?? "";

  const response = await handleApplyPackageUpdateRequest(
    {
      projectRepo: app.projectRepo,
      packageRepository: app.packageRepository,
      marsPackageFetcher: app.marsPackageFetcher,
    },
    { projectId, userId: user.userId, installId },
  );

  return serializeTransport(response);
});
