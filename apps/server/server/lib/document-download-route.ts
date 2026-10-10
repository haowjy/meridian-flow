/** Live document downloads: tree admission before content or binary storage access. */
import type { DocumentId } from "@meridian/contracts";
import { createError, type H3Event, sendRedirect, setHeader } from "nitro/h3";
import { LIVE_TREE } from "../domains/context/tree/tree-view.js";
import { objectStoreKeyFromStorageUrl } from "../domains/storage/index.js";
import type { AppServices } from "./app.js";

export function attachmentFilename(name: string, extension: string): string {
  return extension ? `${name}.${extension}` : name;
}

export async function downloadDocument(
  services: Pick<AppServices, "liveDocuments" | "uploadIdentity" | "objectStore" | "documentSync">,
  documentId: string,
  event: H3Event,
) {
  if ((await services.liveDocuments.findById(LIVE_TREE, documentId as DocumentId)).kind !== "found")
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
}
