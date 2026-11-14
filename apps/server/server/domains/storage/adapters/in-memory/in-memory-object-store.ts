/** In-memory implementation of the object-store port: a Map of bytes+mime keyed by storage URL. Used by tests and local dev; depends inward on the port and URL helper. */
import { Readable } from "node:stream";
import { isSafeKeyPrefix } from "../../object-key.js";
import { createObjectStorageUrl } from "../../object-storage-url.js";
import type {
  ObjectStoreCopyOutput,
  ObjectStoreGetOptions,
  ObjectStoreHead,
  ObjectStorePort,
  ObjectStoreResult,
  ObjectStoreSignedPut,
  ObjectStoreSignedPutOptions,
  ObjectStoreStreamOutput,
} from "../../ports/object-store.js";

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

  async get(
    key: string,
    options?: ObjectStoreGetOptions,
  ): Promise<ObjectStoreResult<{ bytes: Uint8Array; mimeType: string }>> {
    const stored = this.objects.get(key);
    if (!stored) return notFound();
    if (options?.maxBytes !== undefined && stored.bytes.byteLength > options.maxBytes)
      return { ok: false, error: { code: "too_large", message: "Object is too large to read" } };
    return ok({ bytes: stored.bytes, mimeType: stored.mimeType });
  }

  async getStream(key: string): Promise<ObjectStoreResult<ObjectStoreStreamOutput>> {
    const stored = this.objects.get(key);
    if (!stored) return notFound();
    return ok({
      stream: Readable.from([stored.bytes], { objectMode: false }),
      mimeType: stored.mimeType,
      sizeBytes: stored.bytes.byteLength,
    });
  }

  async copy(fromKey: string, toKey: string): Promise<ObjectStoreResult<ObjectStoreCopyOutput>> {
    const stored = this.objects.get(fromKey);
    if (!stored) return notFound();
    this.objects.set(toKey, stored);
    return ok({
      storageUrl: createObjectStorageUrl(toKey),
      mimeType: stored.mimeType,
      sizeBytes: stored.bytes.byteLength,
    });
  }

  async readHead(key: string, headBytes: number): Promise<ObjectStoreResult<ObjectStoreHead>> {
    const stored = this.objects.get(key);
    if (!stored) return notFound();
    return ok({ head: stored.bytes.slice(0, headBytes), sizeBytes: stored.bytes.byteLength });
  }

  /** Tests stand in for the browser with `put` at `key`. */
  async signPut(
    key: string,
    options: ObjectStoreSignedPutOptions,
  ): Promise<ObjectStoreResult<ObjectStoreSignedPut>> {
    return ok({
      url: `/memory-object-store/${encodeURIComponent(key)}`,
      headers: { "Content-Type": options.mimeType },
    });
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
    if (!isSafeKeyPrefix(prefix))
      return { ok: false, error: { code: "invalid_key", message: "Object key prefix is invalid" } };
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

  async getProviderReadLink(): Promise<ObjectStoreResult<string | null>> {
    return ok(null);
  }

  async delete(key: string): Promise<ObjectStoreResult<void>> {
    this.objects.delete(key);
    return ok(undefined);
  }
}

export function createInMemoryObjectStore(): ObjectStorePort {
  return new InMemoryObjectStoreAdapter();
}
