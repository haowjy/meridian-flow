export { ContextFS } from "./adapters/context-fs/context-fs.js";
export {
  DrizzleContextDocumentStore,
  updateDocumentProjectionById,
} from "./adapters/context-fs/drizzle-store.js";
export { InMemoryContextDocumentStore } from "./adapters/context-fs/in-memory-store.js";
export { firstLineMatch } from "./adapters/context-fs/match.js";
export { joinPath, parseFilename, renderFilename, splitPath } from "./context/paths.js";
export { createContextPortRouter } from "./context/router.js";
export {
  parseContextUri,
  parseUnifiedContextUri,
  toCanonical,
  UNIFIED_CONTEXT_SCHEMES,
} from "./context/uri.js";
export {
  contextPortForProjectAuthorities,
  contextPortForProjectBrowse,
  contextPortForThread,
  resolveThreadContext,
} from "./context-port-resolution.js";
export {
  createProjectContextDocumentStore,
  createWorkContextDocumentStore,
} from "./context-source-provisioning.js";
export * from "./corpus-import/index.js";
export * from "./figures/index.js";
export * from "./input-ingest/input-ingest-service.js";
export * from "./input-ingest/run-input-paths.js";
export type {
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterSearchHit,
  ContextSchemeAdapter,
  SchemeCapabilities,
} from "./ports/context-adapter.js";
export type {
  ContextDocumentStore,
  ContextFolder,
  CreateBinaryDocumentInput,
  UpsertDocumentInput,
} from "./ports/context-document-store.js";
export type {
  BinaryFileEntry,
  BinaryFileRef,
  ContextCreateUntitledDocumentOptions,
  ContextCreateUntitledDocumentResult,
  ContextEnsureTrackedDocumentResult,
  ContextError,
  ContextFileEntry,
  ContextListEntry,
  ContextPort,
  ContextReadResult,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  DirectoryEntry,
  EditableFileEntry,
  FileEntry,
  FileRef,
  ProjectContextFsScheme,
  SearchResult,
  TrackedFileRef,
  WorkScopedContextFsScheme,
  WriteProvenance,
} from "./ports/context-port.js";
export { createDrizzleResultRepository } from "./promotion/adapters/drizzle-result-repository.js";
export { createInMemoryResultRepository } from "./promotion/adapters/in-memory-result-repository.js";
export { createInterruptArtifactFlush } from "./promotion/interrupt-artifact-flush.js";
export {
  createInterruptFlushService,
  type InterruptFlushManifest,
  type InterruptFlushManifestEntry,
  type InterruptFlushService,
  sourcePathsFromArtifactRefs,
} from "./promotion/interrupt-flush.js";
export type {
  CreateProjectResultInput,
  ProjectResultRecord,
  ResultRepository,
} from "./promotion/ports/result-repository.js";
export { evaluatePromotionPolicy, PROMOTION_POLICY_TABLE } from "./promotion/promotion-policy.js";
export {
  createPromotionService,
  type PromotedArtifact,
  type PromotionService,
} from "./promotion/promotion-service.js";
export type { ResultProvenance } from "./promotion/result-provenance.js";
export {
  createInMemoryUnifiedContextPortFactory,
  createProductionUnifiedContextPortFactory,
  type UnifiedContextPortFactory,
} from "./unified-context-port-factory.js";
export * from "./uploads/index.js";
