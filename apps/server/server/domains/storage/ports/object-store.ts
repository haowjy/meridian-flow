/**
 * Object-store port: the put/get/delete/signed-url contract (plus error and
 * result types) for binary object storage. The boundary the in-memory, local,
 * and s3 adapters implement; callers depend on this, not a concrete backend.
 */
import type { Readable } from "node:stream";

export type ObjectStoreErrorCode = "invalid_key" | "not_found" | "too_large" | "io_error";

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

export interface ObjectStoreGetOptions {
  /**
   * Refuses (`too_large`) an object above this many bytes, or of unreported size, without reading
   * it. Whole-object
   * reads are for bounded things such as previews; anything else uses `getStream` or `copy`.
   */
  maxBytes?: number;
}

export interface ObjectStoreStreamOutput {
  stream: Readable;
  mimeType: string;
  sizeBytes: number;
}

export interface ObjectStoreCopyOutput {
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ObjectStoreSignedUrlOptions {
  /** A `Content-Disposition` value the store sends with the bytes (a download's filename). */
  contentDisposition?: string;
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
  get(
    key: string,
    options?: ObjectStoreGetOptions,
  ): Promise<ObjectStoreResult<ObjectStoreGetOutput>>;
  /** Reads an object as a stream. Destroying the stream abandons the read. */
  getStream(key: string): Promise<ObjectStoreResult<ObjectStoreStreamOutput>>;
  /** Duplicates an object inside the store, bytes never passing through the server. */
  copy(fromKey: string, toKey: string): Promise<ObjectStoreResult<ObjectStoreCopyOutput>>;
  list(
    prefix: string,
    options?: ObjectStoreListOptions,
  ): Promise<ObjectStoreResult<ObjectStoreListOutput>>;
  getSignedUrl(
    key: string,
    options?: ObjectStoreSignedUrlOptions,
  ): Promise<ObjectStoreResult<string>>;
  delete(key: string): Promise<ObjectStoreResult<void>>;
}
