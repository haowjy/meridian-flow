/** GET /api/projects/[projectId]/preferences: returns the authenticated user's persisted thread-list preferences for an owned project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { handleGetProjectPreferencesRequest } from "../../../../lib/project-preferences-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";

  const response = await handleGetProjectPreferencesRequest(
    {
      projectRepo: app.projectRepo,
      preferences: app.preferences,
      packageRepository: app.packageRepository,
    },
    { projectId, userId: user.userId },
  );

  return serializeTransport(response);
});
