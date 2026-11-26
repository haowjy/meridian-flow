export {
  createLinkScopeObserver,
  type LinkScopeObserver,
} from "./adapters/agent-edit-observability.js";
export { createInMemoryCollabDomain } from "./adapters/in-memory/composition.js";
export { createCollabDomain } from "./composition.js";
export * from "./contracts.js";
export {
  type CopyIdentityMap,
  createCopyIdentityMap,
  remapCopiedBlocks,
} from "./domain/copied-blocks.js";
export { createDocumentCreationAggregate } from "./domain/document-creation.js";
export type { Drafts } from "./domain/drafts.js";
export {
  type BindHolder,
  type BindMarkdownInput,
  type BoundWrite,
  createImportLinkBinder,
  type ImportLinkBinder,
  type ImportLinkBinderDeps,
  type LinkBinder,
  LinkBindingInsideTransactionError,
  type PlannedMarkdownInput,
} from "./domain/link-binding.js";
export { ModelEditRefusal } from "./domain/model-edit.js";
export type { ModelEvidence } from "./domain/model-evidence.js";
export {
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
  type LinkScopeKey,
  type ScopePrepareRequest,
} from "./domain/ports/document-link-scope.js";
export type { Draft } from "./domain/ports/draft-store.js";
