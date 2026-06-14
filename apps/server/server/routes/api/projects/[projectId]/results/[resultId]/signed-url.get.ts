import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleProjectResultSignedUrlRequest } from "../../../../../../lib/project-results-route.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const resultId = getRouterParam(event, "resultId") ?? "";
  return serializeTransport(
    await handleProjectResultSignedUrlRequest(
      { projectRepo: app.projectRepo, results: app.results, objectStore: app.objectStore },
      { projectId, resultId, userId: user.userId },
    ),
  );
});
