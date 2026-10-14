/** Owner-gated document file download with a filename derived from its persisted type. */
import { defineEventHandler, getRouterParam } from "nitro/h3";
import type { AppServices } from "../../../../lib/app.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { downloadDocument } from "../../../../lib/document-download-route.js";
import { documentTarget, requireFileGrant } from "../../../../lib/file-access-http.js";

export { attachmentDisposition } from "../../../../lib/document-download-route.js";

type DocumentDownloadRouteServices = {
  liveDocuments: AppServices["liveDocuments"];
  fileAccess: AppServices["fileAccess"];
  uploadIdentity: AppServices["uploadIdentity"];
  objectStore: AppServices["objectStore"];
  documentSync: AppServices["documentSync"];
};

function selectDocumentDownloadRouteServices(app: AppServices): DocumentDownloadRouteServices {
  return {
    liveDocuments: app.liveDocuments,
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
  await requireFileGrant(services.fileAccess, user.userId, documentTarget(documentId), "read");
  return downloadDocument(services, documentId, event);
});
