import type { CorpusImportResponse } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readMultipartFormData,
  setResponseStatus,
} from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { corpusFilesFromMultipart } from "../../../../../lib/corpus-import-route.js";

export default defineEventHandler(async (event): Promise<CorpusImportResponse> => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);

  const files = corpusFilesFromMultipart(await readMultipartFormData(event));
  if (files.length === 0) {
    throw createError({ statusCode: 400, message: "multipart field 'files' is required" });
  }

  const result = await app.corpusImports.importFiles({
    userId: user.userId,
    projectId,
    files,
    source: { kind: "upload" },
  });
  setResponseStatus(event, 201);
  return result;
});
