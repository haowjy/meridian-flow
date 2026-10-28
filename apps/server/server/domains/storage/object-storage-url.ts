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
