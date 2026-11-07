/**
 * Object-store port: the put/get/delete/signed-url contract (plus error and
 * result types) for binary object storage. The boundary the in-memory, local,
 * and s3 adapters implement; callers depend on this, not a concrete backend.
 */
import type { Readable } from "node:stream";

export type ObjectStoreErrorCode = "invalid_key" | "not_found" | "io_error";

export interface ObjectStoreError {
  code: ObjectStoreErrorCode;
  message: string;
}

export type ObjectStoreResult<T> = { ok: true; value: T } | { ok: false; error: ObjectStoreError };

export interface ObjectStorePutOutput {
  /** Stable, non-expiring object reference persisted in relational rows and document text. */
  storageUrl: string;
}

export interface ObjectStoreGetOutput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ObjectStoreListEntry {
  key: string;
  sizeBytes: number;
  mimeType?: string;
}

export interface ObjectStoreListOutput {
  keys: ObjectStoreListEntry[];
  /** Opaque cursor when more keys exist; absent when the prefix listing is complete. */
  cursor?: string;
}

export interface ObjectStoreListOptions {
  cursor?: string;
  /** Maximum keys per page; adapters may apply a lower default cap. */
  limit?: number;
}

export interface ObjectStorePutStreamOptions {
  /**
   * Exact byte length of `body`, which the caller guarantees (S3 needs it before the first
   * byte and can't tell a short stream from a slow one). Adapters that can count refuse a
   * mismatch.
   */
  sizeBytes: number;
  mimeType: string;
}

/**
 * Binary object storage. Callers persist only stable storage URLs; renderers ask
 * the store for short-lived read URLs when bytes are needed.
 */
export interface ObjectStorePort {
  put(
    key: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<ObjectStoreResult<ObjectStorePutOutput>>;
  /**
   * Stores `body` without holding it whole. A stream that errors or is destroyed leaves no
   * object under `key`, and an existing object stays as it was.
   */
  putStream(
    key: string,
    body: Readable,
    options: ObjectStorePutStreamOptions,
  ): Promise<ObjectStoreResult<ObjectStorePutOutput>>;
  get(key: string): Promise<ObjectStoreResult<ObjectStoreGetOutput>>;
  list(
    prefix: string,
    options?: ObjectStoreListOptions,
  ): Promise<ObjectStoreResult<ObjectStoreListOutput>>;
  getSignedUrl(key: string): Promise<ObjectStoreResult<string>>;
  delete(key: string): Promise<ObjectStoreResult<void>>;
}
