/** Public barrel for collab domain contracts and composition factories. */

export { createInMemoryCollabDomain } from "./adapters/in-memory/composition.js";
export { createCollabDomain } from "./composition.js";
export * from "./contracts.js";
export { createDocumentCreationAggregate } from "./domain/document-creation.js";
export type { DocumentLinkSubstitution } from "./domain/document-link-occurrences.js";
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
