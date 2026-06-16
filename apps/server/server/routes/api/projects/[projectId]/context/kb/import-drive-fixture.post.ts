import type { CorpusImportResponse } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleContextKbImportDriveFixtureRequest } from "../../../../../../lib/context-import-route.js";

export default defineEventHandler(async (event): Promise<CorpusImportResponse> => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);

  const result = await handleContextKbImportDriveFixtureRequest(
    { contextPorts: app.contextPorts },
    { userId: user.userId, projectId },
  );
  setResponseStatus(event, 201);
  return result;
});
