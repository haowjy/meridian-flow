/** In-memory implementation of the object-store port: a Map of bytes+mime keyed by storage URL. Used by tests and local dev; depends inward on the port and URL helper. */
import { createObjectStorageUrl } from "../../object-storage-url.js";
import type { ObjectStorePort, ObjectStoreResult } from "../../ports/object-store.js";

interface StoredObject {
  bytes: Uint8Array;
  mimeType: string;
}

function ok<T>(value: T): ObjectStoreResult<T> {
  return { ok: true, value };
}

function notFound(): ObjectStoreResult<never> {
  return { ok: false, error: { code: "not_found", message: "Object not found" } };
}

export class InMemoryObjectStoreAdapter implements ObjectStorePort {
  private readonly objects = new Map<string, StoredObject>();

  async put(
    key: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<ObjectStoreResult<{ storageUrl: string }>> {
    this.objects.set(key, { bytes, mimeType });
    return ok({ storageUrl: createObjectStorageUrl(key) });
  }

  async get(key: string): Promise<ObjectStoreResult<{ bytes: Uint8Array; mimeType: string }>> {
    const stored = this.objects.get(key);
    if (!stored) return notFound();
    return ok({ bytes: stored.bytes, mimeType: stored.mimeType });
  }

  async list(
    prefix: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<
    ObjectStoreResult<{
      keys: Array<{ key: string; sizeBytes: number; mimeType?: string }>;
      cursor?: string;
    }>
  > {
    const limit = options?.limit ?? 1_000;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b));
    const startIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const page = keys.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + page.length;
    return ok({
      keys: page.map((key) => {
        const stored = this.objects.get(key);
        return {
          key,
          sizeBytes: stored?.bytes.byteLength ?? 0,
          mimeType: stored?.mimeType,
        };
      }),
      ...(nextIndex < keys.length ? { cursor: String(nextIndex) } : {}),
    });
  }

  async getSignedUrl(key: string): Promise<ObjectStoreResult<string>> {
    if (!this.objects.has(key)) return notFound();
    return ok(`/memory-object-store/${encodeURIComponent(key)}`);
  }

  async delete(key: string): Promise<ObjectStoreResult<void>> {
    this.objects.delete(key);
    return ok(undefined);
  }
}

export function createInMemoryObjectStore(): ObjectStorePort {
  return new InMemoryObjectStoreAdapter();
}
