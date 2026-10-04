import type { CorpusImportResponse } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readMultipartFormData,
  setResponseStatus,
} from "nitro/h3";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleContextKbImportFilesRequest } from "../../../../../../lib/context-import-route.js";
import { corpusFilesFromMultipart } from "../../../../../../lib/corpus-import-route.js";
import {
  containerTarget,
  requireFileGrant,
  withEditGrants,
} from "../../../../../../lib/file-access-http.js";

export default defineEventHandler(async (event): Promise<CorpusImportResponse> => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);

  const files = corpusFilesFromMultipart(await readMultipartFormData(event));
  if (files.length === 0) {
    throw createError({ statusCode: 400, message: "multipart field 'files' is required" });
  }

  const kb = await requireFileGrant(
    app.fileAccess,
    user.userId,
    await containerTarget(app.workRepo, { projectId, scheme: "kb", workId: null }),
    "edit",
  );
  const result = await withEditGrants(app.fileAccess, [kb], () =>
    handleContextKbImportFilesRequest(
      { contextPorts: app.contextPorts },
      { userId: user.userId, projectId, files, source: { kind: "upload" } },
    ),
  );
  setResponseStatus(event, 201);
  return result;
});
