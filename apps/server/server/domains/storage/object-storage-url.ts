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
