/** Owner-gated document file download with a filename derived from its persisted type. */
import { createError, defineEventHandler, getRouterParam, setHeader } from "nitro/h3";
import { exportFilename } from "../../../../domains/context/index.js";
import { objectStoreKeyFromStorageUrl } from "../../../../domains/storage/index.js";
import type { AppServices } from "../../../../lib/app.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { documentTarget, requireFileGrant } from "../../../../lib/file-access-http.js";
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

type DocumentDownloadRouteServices = {
  fileAccess: AppServices["fileAccess"];
  uploadIdentity: AppServices["uploadIdentity"];
  objectStore: AppServices["objectStore"];
  documentSync: AppServices["documentSync"];
};

function selectDocumentDownloadRouteServices(app: AppServices): DocumentDownloadRouteServices {
  return {
    fileAccess: app.fileAccess,
    uploadIdentity: app.uploadIdentity,
    objectStore: app.objectStore,
    documentSync: app.documentSync,
  };
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const services = selectDocumentDownloadRouteServices(app);
  const documentId = getRouterParam(event, "documentId") ?? "";
  const grant = await requireFileGrant(
    services.fileAccess,
    user.userId,
    documentTarget(documentId),
    "read",
  );
  const projectId = grant.facts.projectId;
  const membership = await services.documentSync.resolveManifestMembership({ projectId });
  if (!membership.members.includes(documentId))
    throw createError({ statusCode: 404, message: "Document not found" });
  const document = await services.uploadIdentity.lookupDocument(documentId);
  if (!document) throw createError({ statusCode: 404, message: "Document not found" });
  let body: string | Buffer;
  let mimeType: string;
  if (!document.storageUrl) {
    // Only the live read spells links where their targets sit now; the stored
    // projection can hold a path from before a move, so it is never served.
    const read = await services.documentSync.readAsMarkdown(documentId);
    if (!read.ok) {
      setHeader(event, "Retry-After", "5");
      throw createError({
        statusCode: 503,
        message: "The document couldn't be read right now. Try the download again.",
        data: { retryable: true },
      });
    }
    body = read.value;
    mimeType = "text/markdown; charset=utf-8";
  } else {
    const key = objectStoreKeyFromStorageUrl(document.storageUrl);
    if (!key) throw createError({ statusCode: 500, message: "Document storage URL is invalid" });
    const object = await services.objectStore.get(key);
    if (!object.ok)
      throw createError({
        statusCode: object.error.code === "not_found" ? 404 : 502,
        message: object.error.message,
      });
    body = Buffer.from(object.value.bytes);
    mimeType = object.value.mimeType;
  }
  setHeader(event, "Content-Type", mimeType);
  setHeader(
    event,
    "Content-Disposition",
    attachmentDisposition(exportFilename(document.name, document.extension, document.fileType)),
  );
  return body;
});
