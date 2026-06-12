// @ts-nocheck
/** Barrel: re-exports the storage domain's public surface — the object-store adapters (in-memory, local, s3) and the object-storage-url helpers. */
export {
  createInMemoryObjectStore,
  InMemoryObjectStoreAdapter,
} from "./adapters/in-memory/in-memory-object-store.js";
export {
  LocalObjectStoreAdapter,
  type LocalObjectStoreOptions,
} from "./adapters/local/local-object-store.js";
export {
  createS3ObjectStore,
  S3ObjectStoreAdapter,
  type S3ObjectStoreOptions,
} from "./adapters/s3/s3-object-store.js";
export { createObjectStorageUrl, objectStoreKeyFromStorageUrl } from "./object-storage-url.js";
export type {
  ObjectStoreError,
  ObjectStoreErrorCode,
  ObjectStoreGetOutput,
  ObjectStoreListEntry,
  ObjectStoreListOptions,
  ObjectStoreListOutput,
  ObjectStorePort,
  ObjectStorePutOutput,
  ObjectStoreResult,
} from "./ports/object-store.js";
