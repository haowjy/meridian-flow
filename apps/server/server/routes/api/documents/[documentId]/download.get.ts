/** Owner-gated document file download with a filename derived from its persisted type. */
import { createError, defineEventHandler, getRouterParam, setHeader } from "nitro/h3";
import { ExportReadError } from "../../../../domains/export/domain/project-export.js";
import { attachmentDisposition } from "../../../../lib/attachment-disposition.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { documentTarget, requireFileGrant } from "../../../../lib/file-access-http.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const documentId = getRouterParam(event, "documentId") ?? "";
  const grant = await requireFileGrant(
    app.fileAccess,
    user.userId,
    documentTarget(documentId),
    "read",
  );
  const projectId = grant.facts.projectId;
  const snapshot = await app.projectExport.prepare(projectId, user.userId, {
    scratch: false,
    uploads: false,
  });
  let read: Awaited<ReturnType<typeof snapshot.read>>;
  try {
    read = await snapshot.read(documentId);
  } catch (error) {
    if (!(error instanceof ExportReadError)) throw error;
    const status = {
      not_found: 404,
      storage_invalid: 500,
      storage_unavailable: 502,
      document_unavailable: 503,
    }[error.code];
    if (status === 503) setHeader(event, "Retry-After", "5");
    throw createError({
      statusCode: status,
      message: error.message,
      ...(status === 503 ? { data: { retryable: true } } : {}),
    });
  }
  setHeader(event, "Content-Type", read.mimeType);
  setHeader(event, "Content-Disposition", attachmentDisposition(read.filename));
  return Buffer.from(read.bytes);
});
