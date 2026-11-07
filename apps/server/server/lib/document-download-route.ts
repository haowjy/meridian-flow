/**
 * Live document downloads: tree admission before content or binary storage access, with a
 * filename derived from the document's persisted type (prose leaves as `<name>.md`).
 */
import type { DocumentId } from "@meridian/contracts";
import { createError, type H3Event, sendRedirect, setHeader } from "nitro/h3";
import { exportFilename } from "../domains/context/index.js";
import { LIVE_TREE } from "../domains/context/tree/tree-view.js";
import { objectStoreKeyFromStorageUrl } from "../domains/storage/index.js";
import type { AppServices } from "./app.js";
import { attachmentDisposition } from "./attachment-disposition.js";

export async function downloadDocument(
  services: Pick<AppServices, "liveDocuments" | "uploadIdentity" | "objectStore" | "documentSync">,
  documentId: string,
  event: H3Event,
) {
  if ((await services.liveDocuments.findById(LIVE_TREE, documentId as DocumentId)).kind !== "found")
    throw createError({ statusCode: 404, message: "Document not found" });
  const document = await services.uploadIdentity.lookupDocument(documentId);
  if (!document) throw createError({ statusCode: 404, message: "Document not found" });
  const disposition = attachmentDisposition(
    exportFilename(document.name, document.extension, document.fileType),
  );
  if (document.storageUrl) {
    // The store serves the bytes, so a large file never passes through this process.
    const key = objectStoreKeyFromStorageUrl(document.storageUrl);
    if (!key) throw createError({ statusCode: 500, message: "Document storage URL is invalid" });
    const signed = await services.objectStore.getSignedUrl(key, {
      contentDisposition: disposition,
    });
    if (!signed.ok)
      throw createError({
        statusCode: signed.error.code === "not_found" ? 404 : 502,
        message: signed.error.message,
      });
    setHeader(event, "Cache-Control", "no-store");
    return sendRedirect(event, signed.value, 302);
  }
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
  setHeader(event, "Content-Type", "text/markdown; charset=utf-8");
  setHeader(event, "Content-Disposition", disposition);
  return read.value;
}
