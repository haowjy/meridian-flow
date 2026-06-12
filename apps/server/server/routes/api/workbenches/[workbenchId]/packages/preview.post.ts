/** POST /api/workbenches/[workbenchId]/packages/preview: dry-run Mars package install. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handlePreviewPackageInstallRequest,
  parsePackageInstallPreviewRequest,
} from "../../../../../lib/workbench-package-install-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const body = parsePackageInstallPreviewRequest(await readBody(event));

  const response = await handlePreviewPackageInstallRequest(
    {
      workbenchRepo: app.workbenchRepo,
      packageRepository: app.packageRepository,
      marsPackageFetcher: app.marsPackageFetcher,
    },
    { workbenchId, userId: user.userId, ...body },
  );

  return serializeTransport(response);
});
