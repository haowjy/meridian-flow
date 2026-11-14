/**
 * Object storage URL scheme: builds and parses the stable `object://meridian/<key>`
 * references persisted in DB rows and document text. Owns the single URL format
 * decoupling stored references from any concrete backend; no external deps.
 */
const OBJECT_STORAGE_SCHEME = "object";
const OBJECT_STORAGE_NAMESPACE = "meridian";

export function createObjectStorageUrl(key: string): string {
  return `${OBJECT_STORAGE_SCHEME}://${OBJECT_STORAGE_NAMESPACE}/${key}`;
}

export function objectStoreKeyFromStorageUrl(storageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(storageUrl);
  } catch {
    return null;
  }

  if (url.protocol !== `${OBJECT_STORAGE_SCHEME}:`) return null;
  if (url.hostname !== OBJECT_STORAGE_NAMESPACE) return null;

  const key = url.pathname.replace(/^\/+/, "");
  return key.length > 0 ? key : null;
}

/**
 * Where a file's browser-drawable preview lives: beside the original, derived from its key so
 * that anything that copies, moves or releases the original can find the preview without
 * storing a second reference. Whether one exists is the document's `has_preview`.
 */
export function previewObjectKey(key: string): string {
  return `${key}.preview`;
}

/**
 * Where the text extracted from an EPUB or PDF lives: Markdown beside the original, made by the
 * first `read` that needs it. The original's bytes never change (an upload's key is
 * `uploads/<project>/<doc>` and a copy gets a new key; nothing replaces an object in place), so
 * a text found at this key is the original's text for good.
 */
export function textObjectKey(key: string): string {
  return `${key}.text`;
}

/**
 * Every file derived from an original, the one list release, copy and the import sweep use so
 * none leaves a derived file behind or loses one. A new derived file is added here.
 */
export function derivedObjectKeys(key: string): string[] {
  return [previewObjectKey(key), textObjectKey(key)];
}

/** Image types every supported browser draws from the original. */
const BROWSER_DRAWABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

/**
 * The stored object a browser draws for a file: its preview when the server made one, the
 * original when browsers draw that type as it is, or null when nothing can be drawn and the
 * client shows the file card. The one place this is decided; clients draw what it names.
 */
export function drawObjectKey(file: {
  key: string;
  mimeType: string | null;
  hasPreview: boolean;
}): string | null {
  if (file.hasPreview) return previewObjectKey(file.key);
  return file.mimeType && BROWSER_DRAWABLE.has(file.mimeType) ? file.key : null;
}

/**
 * Where a browser's PUT lands. No row points at this key, so a late or repeated PUT through the
 * signed URL can only change bytes nobody has read yet; finish copies it to `objectKey` before
 * it reads anything. A bucket lifecycle rule on this prefix is the backstop for stray objects.
 */
export function incomingObjectKey(projectId: string, documentId: string): string {
  return `incoming/${projectId}/${documentId}`;
}
