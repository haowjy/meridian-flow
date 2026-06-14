/** POST /api/projects/[projectId]/packages: apply Mars package install. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handleApplyPackageInstallRequest,
  parsePackageInstallApplyRequest,
} from "../../../../../lib/project-package-install-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const body = parsePackageInstallApplyRequest(await readBody(event));

  const response = await handleApplyPackageInstallRequest(
    {
      projectRepo: app.projectRepo,
      packageRepository: app.packageRepository,
      marsPackageFetcher: app.marsPackageFetcher,
    },
    { projectId, userId: user.userId, ...body },
  );

  return serializeTransport(response);
});
