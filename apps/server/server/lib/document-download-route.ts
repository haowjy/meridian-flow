/**
 * Live document downloads: tree admission before content or binary storage access, with a
 * filename derived from the document's persisted type (prose leaves as `<name>.md`).
 */
import type { DocumentId } from "@meridian/contracts";
import { createError, type H3Event, setHeader } from "nitro/h3";
import { exportFilename } from "../domains/context/index.js";
import { LIVE_TREE } from "../domains/context/tree/tree-view.js";
import { objectStoreKeyFromStorageUrl } from "../domains/storage/index.js";
import type { AppServices } from "./app.js";

export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
}
