/** Public barrel for collab domain contracts and composition factories. */

export { createUnscopedAssetPathObserver } from "./adapters/agent-edit-observability.js";
export { createInMemoryCollabDomain } from "./adapters/in-memory/composition.js";
export { createCollabDomain } from "./composition.js";
export * from "./contracts.js";
export { createDocumentCreationAggregate } from "./domain/document-creation.js";
export type { DocumentLinkSubstitution } from "./domain/document-link-occurrences.js";
export {
  type ChangeClaimed,
  liveAfter,
  locationAfter,
  type NamespaceChanges,
  type NamespaceTree,
} from "./domain/namespace-changes.js";
export {
  executeNamespaceReversal,
  planReversalWalk,
  type ReversalLocation,
} from "./domain/namespace-reversal.js";
export type {
  NamespaceChangeRecord,
  NamespaceChangeShape,
  WriteHandleHistory,
} from "./domain/ports/agent-namespace-changes.js";
export type {
  AssetPathProject,
  DocumentAssetPaths,
} from "./domain/ports/document-asset-paths.js";
export type {
  DocumentLinkMover,
  DocumentLinkRewriteClaim,
  RewriteDocumentLinks,
} from "./domain/ports/document-link-rewrite.js";
export {
  DocumentSchemaMajorMismatchError,
  isDocumentSchemaMajorMismatchError,
  isStaleSchema,
} from "./domain/stale-schema.js";
export { countWords } from "./domain/word-count.js";
