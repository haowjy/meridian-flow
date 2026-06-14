/** GET /api/projects/[projectId]/library: full capability inventory for the Library screen. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleGetProjectLibraryRequest } from "../../../../../lib/project-library-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";

  const response = await handleGetProjectLibraryRequest(
    { projectRepo: app.projectRepo, packageRepository: app.packageRepository },
    { projectId, userId: user.userId },
  );

  return serializeTransport(response);
});
