/**
 * Best-effort deletion of stored objects that a committed change stopped referencing
 * (a purged Work's blobs, a tombstoned hidden image's bytes). Runs after the change
 * commits; a failure is reported, never thrown, and a missing object is already gone.
 */
import { objectStoreKeyFromStorageUrl } from "./object-storage-url.js";
import type { ObjectStoreError, ObjectStorePort } from "./ports/object-store.js";

export type ObjectRelease = {
  /** Delete these object keys. */
  keys(keys: readonly string[]): Promise<void>;
  /** Delete the objects these `object://` storage URLs name; other URLs are skipped. */
  storageUrls(storageUrls: readonly string[]): Promise<void>;
};

export function createObjectRelease(deps: {
  objectStore: ObjectStorePort;
  /** A failed delete: the store's error, or a thrown error's message. */
  onFailure(key: string, error: ObjectStoreError | string): void;
}): ObjectRelease {
  async function keys(keys: readonly string[]): Promise<void> {
    for (const key of new Set(keys)) {
      try {
        const result = await deps.objectStore.delete(key);
        if (!result.ok && result.error.code !== "not_found") deps.onFailure(key, result.error);
      } catch (cause) {
        deps.onFailure(key, cause instanceof Error ? cause.message : String(cause));
      }
    }
  }
  return {
    keys,
    storageUrls: (storageUrls) =>
      keys(
        storageUrls.flatMap((url) => {
          const key = objectStoreKeyFromStorageUrl(url);
          return key ? [key] : [];
        }),
      ),
  };
}
