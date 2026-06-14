import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleListProjectResultsRequest } from "../../../../../lib/project-results-route.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  return serializeTransport(
    await handleListProjectResultsRequest(
      { projectRepo: app.projectRepo, results: app.results },
      { projectId, userId: user.userId },
    ),
  );
});
