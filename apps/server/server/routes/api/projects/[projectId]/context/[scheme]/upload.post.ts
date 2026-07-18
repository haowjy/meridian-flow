import {
  createError,
  defineEventHandler,
  readMultipartFormData,
  setResponseStatus,
} from "nitro/h3";
import { mapFigureFileType } from "../../../../../../domains/context/figures/figure-file-types.js";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

function formText(
  parts: Awaited<ReturnType<typeof readMultipartFormData>>,
  name: string,
): string | null {
  const value = parts?.find((part) => part.name === name && !part.filename)?.data;
  if (!value) return null;
  const text = Buffer.from(value).toString("utf8").trim();
  return text.length > 0 ? text : null;
}

export default defineEventHandler(async (event) => {
  const { app, userId, projectId, scheme, workId, port } = await resolveContextRoute(event);
  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === "file" && part.filename);
  if (!file?.filename)
    throw createError({ statusCode: 400, message: "multipart field 'file' is required" });
  const mimeType = file.type || "application/octet-stream";
  const fileType = mapFigureFileType(mimeType);
  if (!fileType)
    throw createError({ statusCode: 415, message: `Unsupported file type: ${mimeType}` });
  const rawPath = formText(parts, "path");
  const path = parseContextMutationPath(rawPath ?? `uploads/${file.filename}`, "path");
  const uri = toUri(scheme, path, workId);
  const existing = await port.stat(uri);
  if (existing.ok) throw createError({ statusCode: 409, message: `Path already exists: ${path}` });
  if (!existing.ok && existing.error.code !== "not_found") contextErrorToHttp(existing.error);
  const objectKey = `context/${projectId}/${scheme}/${crypto.randomUUID()}`;
  const stored = await app.objectStore.put(objectKey, file.data, mimeType);
  if (!stored.ok)
    throw createError({
      statusCode: 502,
      message: `Failed to store file: ${stored.error.message}`,
    });
  const result = await port.writeBinary(uri, {
    fileType,
    storageUrl: stored.value.storageUrl,
    mimeType,
    sizeBytes: file.data.byteLength,
    origin: { type: "human", userId },
  });
  if (!result.ok) {
    await app.objectStore.delete(objectKey).catch(() => undefined);
    contextErrorToHttp(result.error);
  }
  setResponseStatus(event, 201);
  return { ok: true as const, documentId: result.value.documentId };
});
