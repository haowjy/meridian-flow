export { createDrizzleChatUploadsOwners } from "./adapters/chat-uploads-owners.js";
export { ContextFS } from "./adapters/context-fs/context-fs.js";
export { DrizzleContextDocumentStore } from "./adapters/context-fs/drizzle-store.js";
export { fileRefOfVisible } from "./adapters/context-fs/file-ref.js";
export { createDrizzleContextSources } from "./adapters/context-sources.js";
export { createDrizzleDocumentAddressStore } from "./adapters/document-address.js";
export { createDrizzleDocumentArrivals } from "./adapters/document-arrivals.js";
export { createDrizzleDocumentLinkHistory } from "./adapters/document-link-history.js";
export { createDrizzleDocumentLinkScopes } from "./adapters/document-link-scope.js";
export { createDrizzleDocumentPropertiesReader } from "./adapters/drizzle-document-properties-reader.js";
export { createDrizzleContextImportReveal } from "./adapters/drizzle-import-reveal.js";
export { createDrizzleLinkAheadRegistry } from "./adapters/drizzle-link-ahead-registry.js";
export {
  createDrizzleLineageScratchLifecycle,
  type LineageScratchLifecycle,
} from "./adapters/lineage-scratch-lifecycle.js";
export { createDrizzleProjectContextAvailability } from "./adapters/project-context-availability.js";
export { createDrizzleScratchLineages } from "./adapters/scratch-lineages.js";
export {
  exportFilename,
  joinPath,
  renderFilename,
  splitPath,
} from "./context/paths.js";
export { createContextPortRouter } from "./context/router.js";
export {
  contextAreaOf,
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
  provisionProjectSources,
  provisionWorkScratch,
} from "./context-source-provisioning.js";
export { createDocumentAddressResolver } from "./document-address.js";
export { createDocumentLinkResolver } from "./document-link-resolution.js";
export { parseDocumentProperties } from "./document-properties.js";
export { createDocumentRevisions } from "./document-revisions.js";
export * from "./figures/index.js";
export { frontmatterAliases, readFrontmatter } from "./frontmatter.js";
export { type AddressGlob, compileAddressGlob } from "./grep/address-glob.js";
export { compileGrep, type GrepMatcher } from "./grep/matcher.js";
export {
  type ChatFileAddresses,
  createOwnerLookup,
  type OwnerLookup,
} from "./owner-lookup.js";
export type {
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterGrepFile,
  AdapterGrepResult,
  ContextSchemeAdapter,
  SchemeCapabilities,
} from "./ports/context-adapter.js";
export { schemeCapabilities } from "./ports/context-adapter.js";
export type {
  ContextDocumentStore,
  ContextFolder,
} from "./ports/context-document-store.js";
export type { ContextImportDestinationLookup } from "./ports/context-import-destination.js";
export type {
  ContextImportArea,
  ContextImportDestination,
  ContextImportLinkCandidate,
  ContextImportRead,
} from "./ports/context-import-read.js";
export type {
  ContextImportReveal,
  ImportRevealNode,
} from "./ports/context-import-reveal.js";
export type {
  BinaryFileEntry,
  BinaryFileRef,
  ContextDeleted,
  ContextDeleteOptions,
  ContextEnsureTrackedDocumentResult,
  ContextError,
  ContextFileEntry,
  ContextListEntry,
  ContextListing,
  ContextListOptions,
  ContextMoveAcrossListsChange,
  ContextMovedAcrossLists,
  ContextPort,
  ContextReadResult,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  CopySourceView,
  DirectoryEntry,
  EditableFileEntry,
  FileEntry,
  FileRef,
  GrepFile,
  GrepMode,
  GrepPassage,
  GrepQuery,
  GrepResult,
  ProjectContextFsScheme,
  TrackedFileRef,
  WorkScopedContextFsScheme,
  WriteProvenance,
} from "./ports/context-port.js";
export type { ContextSources } from "./ports/context-sources.js";
export type { DocumentAddressResolver } from "./ports/document-address.js";
export type { DocumentArrivals } from "./ports/document-arrivals.js";
export type {
  DocumentLinkResolver,
  ResolveDocumentLinkInput,
  ResolvedDocumentLink,
} from "./ports/document-link-resolver.js";
export type { DocumentPropertiesReader } from "./ports/document-properties-reader.js";
export type {
  DocumentRemoval,
  DocumentRemovals,
} from "./ports/document-removal.js";
export type { DocumentRevisions } from "./ports/document-revisions.js";
export type { DocumentTrash } from "./ports/document-trash.js";
export {
  type AheadRegistration,
  type LinkAheadRegistry,
  RegistrationInsideTransactionError,
} from "./ports/link-ahead-registry.js";
export type {
  HeldContextNode,
  HeldContextNodeAddress,
  ProjectContextAvailabilityPort,
} from "./ports/project-context-availability.js";
export type { ProjectHint, ProjectHintPort, ProjectWakePort } from "./ports/project-hints.js";
export {
  createProjectHints,
  createProjectWakeHub,
  type ProjectWakeHub,
} from "./project-wake-hub.js";
export { createDrizzleResultRepository } from "./promotion/adapters/drizzle-result-repository.js";
export { createInMemoryResultRepository } from "./promotion/adapters/in-memory-result-repository.js";
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
export { createDrizzleDocumentTrash } from "./tree/drizzle-document-trash.js";
export { createDrizzleContextImportDestinationLookup } from "./tree/import-destination.js";
export { createDrizzleContextImportRead } from "./tree/import-read.js";
export {
  createTrashEntries,
  type DiscardedTree,
  discardedTree,
  restoreDiscardedTree,
  type TrashEntries,
  type TrashTreeEntry,
} from "./tree/trash-entries.js";
export * from "./tree/tree-view.js";
export {
  createProductionUnifiedContextPortFactory,
  type UnifiedContextPortFactory,
} from "./unified-context-port-factory.js";
export * from "./uploads/index.js";
