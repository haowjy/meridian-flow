export { createDrizzleContextCatalog } from "./adapters/context-catalog.js";
export { ContextFS } from "./adapters/context-fs/context-fs.js";
export { guardWorkContextRestore } from "./adapters/context-fs/document-locations.js";
export { DrizzleContextDocumentStore } from "./adapters/context-fs/drizzle-store.js";
export { DrizzleContextTreeMutationStore } from "./adapters/context-fs/drizzle-tree-mutation-store.js";
export { InMemoryContextDocumentStore } from "./adapters/context-fs/in-memory-store.js";
export { createDrizzleDocumentAddressStore } from "./adapters/document-address.js";
export { createDrizzleDocumentArrivals } from "./adapters/document-arrivals.js";
export { createDrizzleDocumentLinkHistory } from "./adapters/document-link-history.js";
export {
  createDrizzleDocumentLinkScopes,
  type LinkScopeMembership,
} from "./adapters/document-link-scope.js";
export { createDrizzleContextBulkCreation } from "./adapters/drizzle-context-bulk-creation.js";
export { createDrizzleDocumentPropertiesReader } from "./adapters/drizzle-document-properties-reader.js";
export { createDrizzleContextImportLocations } from "./adapters/drizzle-import-locations.js";
export { createDrizzleLinkAheadRegistry } from "./adapters/drizzle-link-ahead-registry.js";
export { InMemoryContextCatalog } from "./adapters/in-memory-context-catalog.js";
export {
  createDrizzleLineageScratchLifecycle,
  type LineageScratchLifecycle,
  lineageHasLiveMember,
} from "./adapters/lineage-scratch-lifecycle.js";
export { createDrizzleProjectContextAvailability } from "./adapters/project-context-availability.js";
export { createDrizzleScratchLineages } from "./adapters/scratch-lineages.js";
export { exportFilename, joinPath, renderFilename, splitPath } from "./context/paths.js";
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
export { createDocumentAddressResolver } from "./document-address.js";
export { createDocumentLinkResolver } from "./document-link-resolution.js";
export { parseDocumentProperties } from "./document-properties.js";
export { createDocumentRevisions } from "./document-revisions.js";
export * from "./figures/index.js";
export { frontmatterAliases, readFrontmatter } from "./frontmatter.js";
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
  ContextBulkCreation,
  ContextBulkCreationInput,
} from "./ports/context-bulk-creation.js";
export type {
  ContextCatalog,
  ContextCatalogFileMutationPort,
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
export { ContextEntryConflictError } from "./ports/context-document-store.js";
export {
  ContextImportDestinationError,
  type ContextImportLocations,
  ContextImportParentMovedError,
} from "./ports/context-import-locations.js";
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
export type { DocumentArrivals } from "./ports/document-arrivals.js";
export type {
  DocumentLinkResolver,
  DocumentLinkTarget,
  ResolveDocumentLinkInput,
  ResolvedDocumentLink,
} from "./ports/document-link-resolver.js";
export type { DocumentPropertiesReader } from "./ports/document-properties-reader.js";
export type { DocumentRevisions } from "./ports/document-revisions.js";
export {
  type AheadRegistration,
  type LinkAheadRegistry,
  RegistrationInsideTransactionError,
} from "./ports/link-ahead-registry.js";
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
