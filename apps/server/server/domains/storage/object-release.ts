import { derivedObjectKeys, objectStoreKeyFromStorageUrl } from "./object-storage-url.js";
import type { ObjectStoreError, ObjectStorePort } from "./ports/object-store.js";

export type ObjectRelease = {
  keys(keys: readonly string[]): Promise<void>;
  storageUrls(storageUrls: readonly string[]): Promise<void>;
};

export function createObjectRelease(deps: {
  objectStore: Pick<ObjectStorePort, "delete">;
  onFailure(key: string, error: ObjectStoreError | string): void;
}): ObjectRelease {
  async function keys(keys: readonly string[]): Promise<void> {
    for (const key of new Set(
      keys.flatMap((original) => [original, ...derivedObjectKeys(original)]),
    )) {
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
