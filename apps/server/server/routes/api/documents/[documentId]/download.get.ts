import { createError, defineEventHandler, getRouterParam, sendRedirect, setHeader } from "nitro/h3";
import { objectStoreKeyFromStorageUrl } from "../../../../domains/storage/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
export function attachmentFilename(name: string, extension: string): string {
  return extension ? `${name}.${extension}` : name;
}
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const documentId = getRouterParam(event, "documentId") ?? "";
  if (!(await app.documentAccess.canAccessDocument(user.userId, documentId)))
    throw createError({ statusCode: 404, message: "Document not found" });
  const document = await app.uploadDocuments.getDocument(documentId);
  if (!document) throw createError({ statusCode: 404, message: "Document not found" });
  if (!document.storageUrl) {
    const read = await app.documentSync.readAsMarkdown(documentId);
    const markdown = read.ok ? read.value : document.markdownProjection;
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
  const signed = await app.objectStore.getSignedUrl(key);
  if (!signed.ok)
    throw createError({
      statusCode: signed.error.code === "not_found" ? 404 : 502,
      message: signed.error.message,
    });
  return sendRedirect(event, signed.value, 302);
});
