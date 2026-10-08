export {
  createDrizzleAssetPathResolver,
  type MutableAssetPathResolver,
} from "./adapters/asset-path-resolver.js";
export { createDrizzleContextCatalog } from "./adapters/context-catalog.js";
export { ContextFS } from "./adapters/context-fs/context-fs.js";
export { DrizzleContextDocumentStore } from "./adapters/context-fs/drizzle-store.js";
export { DrizzleContextTreeMutationStore } from "./adapters/context-fs/drizzle-tree-mutation-store.js";
export { InMemoryContextDocumentStore } from "./adapters/context-fs/in-memory-store.js";
export { createDrizzleDocumentAddressStore } from "./adapters/document-address.js";
export { createDrizzleDocumentLinkHistory } from "./adapters/document-link-history.js";
export { InMemoryContextCatalog } from "./adapters/in-memory-context-catalog.js";
export { reconcileLineageScratch } from "./adapters/lineage-scratch-lifecycle.js";
export { createDrizzleProjectContextAvailability } from "./adapters/project-context-availability.js";
export { createDrizzleScratchLineages } from "./adapters/scratch-lineages.js";
export { joinPath, parseFilename, renderFilename, splitPath } from "./context/paths.js";
export { createContextPortRouter } from "./context/router.js";
export {
  parseContextUri,
  parseUnifiedContextUri,
  toCanonical,
  UNIFIED_CONTEXT_SCHEMES,
} from "./context/uri.js";
export {
  type ContextCatalogWakeHub,
  createContextCatalogWakeHub,
} from "./context-catalog-wake-hub.js";
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
export { createDocumentAddressResolver } from "./document-address.js";
export { createDocumentLinkResolver } from "./document-link-resolution.js";
export { createDocumentRevisions } from "./document-revisions.js";
export * from "./figures/index.js";
export { createLinkUpdateWorker, type LinkUpdateWorker } from "./links/link-update-worker.js";
export type {
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterSearchHit,
  ContextSchemeAdapter,
  SchemeCapabilities,
} from "./ports/context-adapter.js";
export { schemeCapabilities } from "./ports/context-adapter.js";
export type {
  ContextCatalog,
  ContextCatalogMutationPort,
  ContextCatalogWakePort,
  ProjectCatalogLifecyclePort,
  ProjectDocumentCatalogRefreshPort,
} from "./ports/context-catalog.js";
export type {
  ContextDocumentStore,
  ContextFolder,
  CreateBinaryDocumentInput,
  CreateDocumentInput,
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
  ContextListing,
  ContextListOptions,
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
export type { DocumentAddressResolver } from "./ports/document-address.js";
export type {
  DocumentLinkResolver,
  DocumentLinkTarget,
  ResolveDocumentLinkInput,
  ResolvedDocumentLink,
} from "./ports/document-link-resolver.js";
export type { DocumentRevisions } from "./ports/document-revisions.js";
export type {
  ProjectContextAvailabilityMutationPort,
  ProjectContextAvailabilityPort,
} from "./ports/project-context-availability.js";
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
  type ScratchLineage,
  type ScratchLineages,
  type ScratchOwner,
  scratchOwnerFor,
} from "./scratch-owner.js";
export {
  createInMemoryUnifiedContextPortFactory,
  createProductionUnifiedContextPortFactory,
  type UnifiedContextPortFactory,
} from "./unified-context-port-factory.js";
export * from "./uploads/index.js";
