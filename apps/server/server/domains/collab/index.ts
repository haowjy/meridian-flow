/** Public barrel for collab domain contracts and composition factories. */

export {
  createLinkScopeObserver,
  type LinkScopeObserver,
} from "./adapters/agent-edit-observability.js";
export { createInMemoryCollabDomain } from "./adapters/in-memory/composition.js";
export { createCollabDomain } from "./composition.js";
export * from "./contracts.js";
export { BranchWriterRefusedError } from "./domain/branch-coordinator.js";
export { createDocumentCreationAggregate } from "./domain/document-creation.js";
export type { Drafts } from "./domain/drafts.js";
export {
  type BindHolder,
  type BindMarkdownInput,
  type BoundWrite,
  type LinkBinder,
  LinkBindingInsideTransactionError,
} from "./domain/link-binding.js";
export {
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
  type LinkScopeKey,
  type ScopePrepareRequest,
} from "./domain/ports/document-link-scope.js";
export type { Draft, DraftStatus } from "./domain/ports/draft-store.js";
export {
  DocumentSchemaMajorMismatchError,
  isDocumentSchemaMajorMismatchError,
  isStaleSchema,
} from "./domain/stale-schema.js";
