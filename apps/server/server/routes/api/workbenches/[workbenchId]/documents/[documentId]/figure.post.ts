import { serializeTransport } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readMultipartFormData,
  setResponseStatus,
} from "nitro/h3";
import { requireWorkbenchOwner } from "../../../../../../domains/workbenches/index.js";
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
function toHttpError(error: { code: string; message: string }) {
  if (error.code === "document_not_found")
    return createError({ statusCode: 404, message: "Document not found" });
  if (error.code === "unsupported_mime_type")
    return createError({ statusCode: 415, message: error.message });
  return createError({ statusCode: 502, message: error.message });
}
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const documentId = getRouterParam(event, "documentId") ?? "";
  await requireWorkbenchOwner({ workbenches: app.workbenchRepo }, workbenchId, user.userId);
  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === "file" && part.filename);
  if (!file) throw createError({ statusCode: 400, message: "multipart field 'file' is required" });
  const result = await app.figureAssets.uploadFigure({
    workbenchId,
    documentId,
    bytes: file.data,
    mimeType: file.type || "application/octet-stream",
    filename: file.filename,
    alt: formText(parts, "alt"),
    label: formText(parts, "label"),
    caption: formText(parts, "caption"),
  });
  if (!result.ok) throw toHttpError(result.error);
  setResponseStatus(event, 201);
  return serializeTransport(result.value);
});
