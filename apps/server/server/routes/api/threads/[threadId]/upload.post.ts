/** POST /api/threads/[threadId]/upload: imports a thread-scoped upload. */
import type { UploadThreadDocumentResponse } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getRequestHeader,
  getRouterParam,
  readMultipartFormData,
  setResponseStatus,
} from "nitro/h3";
import type { ThreadUploadImportError } from "../../../../domains/context/index.js";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function checkContentLength(value: string | undefined): void {
  if (!value) return;
  const bytes = Number(value);
  if (Number.isFinite(bytes) && bytes > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, message: "Upload exceeds 50MB limit" });
  }
}

function cleanFilename(filename: string): string {
  const cleaned = filename.split(/[\\/]/).pop()?.trim() ?? "";
  return cleaned || "upload";
}

function importErrorToHttp(error: ThreadUploadImportError): never {
  switch (error.code) {
    case "object_store_error":
    case "collab_error":
      throw createError({ statusCode: 502, message: error.message });
    case "repository_error":
      throw createError({ statusCode: 500, message: error.message });
  }
}

export default defineEventHandler(async (event): Promise<UploadThreadDocumentResponse> => {
  checkContentLength(getRequestHeader(event, "content-length"));

  const { app, user } = await requireAppUser(event);
  const { repos, projectRepo, threadUploadImports } = app;
  const threadId = getRouterParam(event, "threadId") ?? "";
  const thread = await requireThreadOwner(
    { threads: repos.threads, projects: projectRepo },
    threadId,
    user.userId,
  );

  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === "file" && part.filename);
  if (!file) throw createError({ statusCode: 400, message: "multipart field 'file' is required" });
  if (file.data.byteLength > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, message: "Upload exceeds 50MB limit" });
  }

  const result = await threadUploadImports.importUpload({
    projectId: thread.projectId,
    threadId: thread.id,
    filename: cleanFilename(file.filename ?? "upload"),
    bytes: file.data,
    mimeType: file.type?.trim() ?? "",
  });
  if (!result.ok) importErrorToHttp(result.error);

  setResponseStatus(event, 201);
  return { upload: result.value };
});
