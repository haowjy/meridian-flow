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
   * Refuses (`too_large`) an object above this many bytes without reading it. Whole-object
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

export interface ObjectStoreSignedPutOptions {
  /** The exact byte length the URL accepts; any other length is refused by the store. */
  sizeBytes: number;
  /** The exact `Content-Type` the URL accepts. */
  mimeType: string;
}

export interface ObjectStoreSignedPut {
  url: string;
  /** Headers the browser must send as given. `Content-Length` is not among them: the browser sets it. */
  headers: Record<string, string>;
}

export interface ObjectStoreHead {
  /** The object's first bytes, at most the requested count; empty for an empty object. */
  head: Uint8Array;
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
  /**
   * Reads an object's size and first `headBytes` bytes without reading the rest. An empty
   * object answers size 0 and an empty head.
   */
  readHead(key: string, headBytes: number): Promise<ObjectStoreResult<ObjectStoreHead>>;
  list(
    prefix: string,
    options?: ObjectStoreListOptions,
  ): Promise<ObjectStoreResult<ObjectStoreListOutput>>;
  /**
   * A short-lived URL that lets a browser PUT one object of exactly `sizeBytes` and `mimeType`
   * to `key`, with no object needing to exist first. A PUT of another length or type is
   * refused, and the URL may be used again: a second PUT replaces the object, so the key
   * must be one no row points at.
   */
  signPut(
    key: string,
    options: ObjectStoreSignedPutOptions,
  ): Promise<ObjectStoreResult<ObjectStoreSignedPut>>;
  getSignedUrl(
    key: string,
    options?: ObjectStoreSignedUrlOptions,
  ): Promise<ObjectStoreResult<string>>;
  delete(key: string): Promise<ObjectStoreResult<void>>;
}
