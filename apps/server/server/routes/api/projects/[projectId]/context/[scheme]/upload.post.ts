import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readMultipartFormData,
  setResponseStatus,
} from "nitro/h3";
import { mapFigureFileType } from "../../../../../../domains/context/figures/figure-file-types.js";
import type { ContextError } from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";

function formText(
  parts: Awaited<ReturnType<typeof readMultipartFormData>>,
  name: string,
): string | null {
  const value = parts?.find((part) => part.name === name && !part.filename)?.data;
  if (!value) return null;
  const text = Buffer.from(value).toString("utf8").trim();
  return text.length > 0 ? text : null;
}
function parseScheme(value: string): ProjectContextTreeScheme {
  if (value === "kb" || value === "work" || value === "user" || value === "fs1") return value;
  throw createError({ statusCode: 400, message: `Unsupported context scheme: ${value}` });
}
function sanitizePath(raw: string): string {
  const path = raw.trim();
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0)
    throw createError({ statusCode: 400, message: "`path` must name a non-root entry" });
  for (const seg of segments)
    if (seg === "." || seg === "..")
      throw createError({ statusCode: 400, message: "`path` may not contain '.' or '..'" });
  return path;
}
const toUri = (scheme: ProjectContextTreeScheme, path: string) =>
  `${scheme}://${path.replace(/^\/+/, "").replace(/\/+$/, "")}`;
function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "invalid_uri":
      throw createError({ statusCode: 400, message: error.reason });
    case "permission_denied":
      throw createError({ statusCode: 403, message: "Context access denied" });
    case "not_found":
      throw createError({ statusCode: 404, message: "Context path not found" });
    case "context_unavailable":
      throw createError({ statusCode: 503, message: "Context is unavailable" });
    case "io_error":
      throw createError({ statusCode: 502, message: error.message });
  }
}
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === "file" && part.filename);
  if (!file?.filename)
    throw createError({ statusCode: 400, message: "multipart field 'file' is required" });
  const mimeType = file.type || "application/octet-stream";
  const fileType = mapFigureFileType(mimeType);
  if (!fileType)
    throw createError({ statusCode: 415, message: `Unsupported file type: ${mimeType}` });
  const rawPath = formText(parts, "path");
  const path = rawPath ? sanitizePath(rawPath) : `/uploads/${file.filename}`;
  const port = app.contextPorts.forProject(projectId, user.userId);
  const uri = toUri(scheme, path);
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
    origin: { type: "human", userId: user.userId },
  });
  if (!result.ok) {
    await app.objectStore.delete(objectKey).catch(() => undefined);
    contextErrorToHttp(result.error);
  }
  setResponseStatus(event, 201);
  return { ok: true as const, documentId: result.value.documentId };
});
