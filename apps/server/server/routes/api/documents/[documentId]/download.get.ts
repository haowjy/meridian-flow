import { createError, defineEventHandler, getRouterParam, sendRedirect, setHeader } from "nitro/h3";
import { objectStoreKeyFromStorageUrl } from "../../../../domains/storage/index.js";
import type { AppServices } from "../../../../lib/app.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { documentTarget, requireFileGrant } from "../../../../lib/file-access-http.js";
export function attachmentFilename(name: string, extension: string): string {
  return extension ? `${name}.${extension}` : name;
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
    const markdown = read.value;
    setHeader(event, "Content-Type", "text/markdown; charset=utf-8");
    setHeader(
      event,
      "Content-Disposition",
      `attachment; filename="${attachmentFilename(document.name, document.extension)}"`,
    );
    return markdown;
  }
  const key = objectStoreKeyFromStorageUrl(document.storageUrl);
  if (!key) throw createError({ statusCode: 500, message: "Document storage URL is invalid" });
  const signed = await services.objectStore.getSignedUrl(key);
  if (!signed.ok)
    throw createError({
      statusCode: signed.error.code === "not_found" ? 404 : 502,
      message: signed.error.message,
    });
  return sendRedirect(event, signed.value, 302);
});
