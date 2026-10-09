/** Public barrel for collab domain contracts and composition factories. */

export { createUnscopedAssetPathObserver } from "./adapters/agent-edit-observability.js";
export { createInMemoryCollabDomain } from "./adapters/in-memory/composition.js";
export { createCollabDomain } from "./composition.js";
export * from "./contracts.js";
export { createDocumentCreationAggregate } from "./domain/document-creation.js";
export type {
  AssetPathProject,
  AssetPathResolver,
  DocumentAssetPaths,
} from "./domain/ports/document-asset-paths.js";
export {
  DocumentSchemaMajorMismatchError,
  isDocumentSchemaMajorMismatchError,
  isStaleSchema,
} from "./domain/stale-schema.js";
export { countWords } from "./domain/word-count.js";
