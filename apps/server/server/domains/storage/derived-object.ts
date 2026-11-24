import type { ObjectStorePort } from "./ports/object-store.js";

export async function putDerivedObject(
  objectStore: Pick<ObjectStorePort, "put" | "readHead" | "delete">,
  derived: { originalKey: string; key: string; bytes: Uint8Array; mimeType: string },
): Promise<boolean> {
  const put = await objectStore.put(derived.key, derived.bytes, derived.mimeType);
  if (!put.ok) return false;
  const original = await objectStore.readHead(derived.originalKey, 0);
  if (original.ok || original.error.code !== "not_found") return true;
  await objectStore.delete(derived.key);
  return false;
}
