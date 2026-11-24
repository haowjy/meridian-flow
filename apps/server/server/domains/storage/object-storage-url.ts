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

export function previewObjectKey(key: string): string {
  return `${key}.preview`;
}

export function textObjectKey(key: string): string {
  return `${key}.text`;
}

export function derivedObjectKeys(key: string): string[] {
  return [previewObjectKey(key), textObjectKey(key)];
}

const BROWSER_DRAWABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

export function drawObjectKey(file: {
  key: string;
  mimeType: string | null;
  hasPreview: boolean;
}): string | null {
  if (file.hasPreview) return previewObjectKey(file.key);
  return file.mimeType && BROWSER_DRAWABLE.has(file.mimeType) ? file.key : null;
}

export function chatMediaPrefix(threadId: string): string {
  return `chat-media/${threadId}/`;
}

export function incomingObjectKey(projectId: string, documentId: string): string {
  return `incoming/${projectId}/${documentId}`;
}
