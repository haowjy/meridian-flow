/** GET /api/projects/[projectId]/working-set: returns the authenticated writer's cross-device snapshot or null. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { handleGetWorkingSetRequest } from "../../../../lib/working-set-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const response = await handleGetWorkingSetRequest(
    {
      projectRepo: app.projectRepo,
      workingSet: app.workingSet,
      works: app.works,
      threads: app.repos.threads,
    },
    { projectId: getRouterParam(event, "projectId") ?? "", userId: user.userId },
  );
  return serializeTransport(response);
});
