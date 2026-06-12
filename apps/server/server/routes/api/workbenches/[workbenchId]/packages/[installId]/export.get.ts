/** GET /api/workbenches/[workbenchId]/packages/[installId]/export: zip download of current package content. */
import { defineEventHandler, getRouterParam, setHeader } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleExportPackageRequest } from "../../../../../../lib/workbench-package-export-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const installId = getRouterParam(event, "installId") ?? "";

  const exported = await handleExportPackageRequest(
    {
      workbenchRepo: app.workbenchRepo,
      packageRepository: app.packageRepository,
    },
    { workbenchId, userId: user.userId, installId },
  );

  setHeader(event, "Content-Type", "application/zip");
  setHeader(event, "Content-Disposition", `attachment; filename="${exported.filename}"`);
  return exported.body;
});
