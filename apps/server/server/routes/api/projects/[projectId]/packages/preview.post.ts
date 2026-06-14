/** POST /api/projects/[projectId]/packages/preview: dry-run Mars package install. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handlePreviewPackageInstallRequest,
  parsePackageInstallPreviewRequest,
} from "../../../../../lib/project-package-install-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const body = parsePackageInstallPreviewRequest(await readBody(event));

  const response = await handlePreviewPackageInstallRequest(
    {
      projectRepo: app.projectRepo,
      packageRepository: app.packageRepository,
      marsPackageFetcher: app.marsPackageFetcher,
    },
    { projectId, userId: user.userId, ...body },
  );

  return serializeTransport(response);
});
