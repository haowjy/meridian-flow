import type { Readable } from "node:stream";

export type ObjectStoreErrorCode = "invalid_key" | "not_found" | "too_large" | "io_error";

export interface ObjectStoreError {
  code: ObjectStoreErrorCode;
  message: string;
}

export type ObjectStoreResult<T> = { ok: true; value: T } | { ok: false; error: ObjectStoreError };

export interface ObjectStorePutOutput {
  storageUrl: string;
}

export interface ObjectStoreGetOutput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ObjectStoreGetOptions {
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
  sizeBytes: number;
  mimeType: string;
}

export interface ObjectStoreSignedPut {
  url: string;
  headers: Record<string, string>;
}

export interface ObjectStoreHead {
  head: Uint8Array;
  sizeBytes: number;
}

export interface ObjectStoreSignedUrlOptions {
  contentDisposition?: string;
}

export interface ObjectStoreProviderLinkOptions {
  signedAt: Date;
  expiresInSeconds: number;
}

export interface ObjectStoreListEntry {
  key: string;
  sizeBytes: number;
  mimeType?: string;
}

export interface ObjectStoreListOutput {
  keys: ObjectStoreListEntry[];
  cursor?: string;
}

export interface ObjectStoreListOptions {
  cursor?: string;
  limit?: number;
}

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
  getStream(key: string): Promise<ObjectStoreResult<ObjectStoreStreamOutput>>;
  copy(fromKey: string, toKey: string): Promise<ObjectStoreResult<ObjectStoreCopyOutput>>;
  readHead(key: string, headBytes: number): Promise<ObjectStoreResult<ObjectStoreHead>>;
  list(
    prefix: string,
    options?: ObjectStoreListOptions,
  ): Promise<ObjectStoreResult<ObjectStoreListOutput>>;
  signPut(
    key: string,
    options: ObjectStoreSignedPutOptions,
  ): Promise<ObjectStoreResult<ObjectStoreSignedPut>>;
  getSignedUrl(
    key: string,
    options?: ObjectStoreSignedUrlOptions,
  ): Promise<ObjectStoreResult<string>>;
  getProviderReadLink(
    key: string,
    options: ObjectStoreProviderLinkOptions,
  ): Promise<ObjectStoreResult<string | null>>;
  delete(key: string): Promise<ObjectStoreResult<void>>;
}
