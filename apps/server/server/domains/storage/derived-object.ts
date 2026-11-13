/**
 * Stores a file derived from an original (`derivedObjectKeys`) so it can't outlive it. A release
 * deletes the original, then its derived keys; a conversion that reads the original before the
 * release and puts after it would leave the derived file behind. Checking the original after the
 * put closes that: the release either saw the derived file or the check sees the original gone.
 */
import type { ObjectStorePort } from "./ports/object-store.js";

/** Whether the derived file is stored: false when the put failed or the original is gone (and the file removed). */
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
