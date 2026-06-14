/** PUT /api/projects/[projectId]/preferences: partially upserts the authenticated user's project thread-list preferences after project ownership is verified. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  handlePutProjectPreferencesRequest,
  parseUpdateProjectPreferencesRequest,
} from "../../../../lib/project-preferences-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const body = parseUpdateProjectPreferencesRequest(await readBody(event));

  const response = await handlePutProjectPreferencesRequest(
    {
      projectRepo: app.projectRepo,
      preferences: app.preferences,
      packageRepository: app.packageRepository,
    },
    { projectId, userId: user.userId, body },
  );

  return serializeTransport(response);
});
