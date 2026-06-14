/** GET /api/projects/[projectId]/packages/[installId]/export: zip download of current package content. */
import { defineEventHandler, getRouterParam, setHeader } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleExportPackageRequest } from "../../../../../../lib/project-package-export-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const installId = getRouterParam(event, "installId") ?? "";

  const exported = await handleExportPackageRequest(
    {
      projectRepo: app.projectRepo,
      packageRepository: app.packageRepository,
    },
    { projectId, userId: user.userId, installId },
  );

  setHeader(event, "Content-Type", "application/zip");
  setHeader(event, "Content-Disposition", `attachment; filename="${exported.filename}"`);
  return exported.body;
});
