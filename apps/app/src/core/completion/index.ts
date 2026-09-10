/**
 * Completion: the headless half of every menu a writer types underneath.
 *
 * Three renderer-neutral concerns live here: the suggestion lifecycle every
 * trigger publishes through, the one reference ranking/identity policy, and
 * the hierarchical browser that projects F1's normalized catalog. Nothing in
 * this module imports ProseMirror, React, or a host insertion command. The one
 * piece of geometry a menu carries is `anchorRect`, supplied by its host.
 *
 * **Why this sits beside `core/editor` rather than inside it.** Read the real
 * dependency graph: policy depends only on contracts, while the browser reads
 * the client catalog port and publishes through the lifecycle. Their consumers
 * are the editor's TipTap lanes, editor surfaces, and shared Composer. Imports
 * run `core/*` → `features/*`, and one feature never
 * reaches into another's internals, so `core/` is the shallowest node covering
 * every consumer. Left under `core/editor`, the Composer would have to import
 * the editor to rank or browse a reference, which is a layering smell
 * standing in for a shared module. That is the same reason `core/session` and
 * `core/transport` are siblings rather than tenants of whoever needed them
 * first.
 *
 * **Why not a package.** Nothing outside `apps/app` completes anything: the
 * server resolves links, it does not rank them. A package would buy a build
 * target and an export boundary for zero cross-app consumers.
 *
 * **Why "completion" and not "references".** The store serves the slash menu,
 * which references nothing — it offers blocks. Reference candidates are one
 * kind of completion, so the reference catalog fits under this name and the
 * store does not fit under that one.
 */

export {
  createDomInputSuggestionTransport,
  type DomInputSelection,
  type DomInputSuggestionTransport,
  type DomInputSuggestionTransportOptions,
} from "./dom-input-suggestion-transport";
export {
  createReferenceBrowserController,
  type ReferenceBrowserController,
  type ReferenceBrowserMeta,
  type ReferenceBrowserOpenContext,
  type ReferenceBrowserOptions,
  type ReferenceBrowserState,
  type ReferenceCatalogPort,
} from "./reference-browser";
export {
  type AuthoritativeReference,
  authoritativeReferenceForFile,
  canonicalReferenceUri,
  MAX_REFERENCE_QUERY_LENGTH,
  normalizeReferenceName,
  REFERENCE_ROW_LIMIT,
  type ReferenceAuthorityIndex,
  type ReferenceKind,
  type ReferenceNavigationAction,
  type ReferencePolicyOptions,
  type ReferenceRankingPriors,
  type ReferenceRow,
  type ReferenceSelectAction,
  rankReferenceRows,
  referenceAuthorityIndex,
  type StableReferenceAuthority,
  validReferenceQuery,
} from "./reference-policy";
export {
  createDefaultSuggestionDriver,
  type SuggestionDriver,
  type SuggestionDriverFrame,
  type SuggestionMenuModel,
  type SuggestionTriggerRange,
} from "./suggestion-driver";
export {
  closedSuggestionMenu,
  type SuggestionChoiceAction,
  type SuggestionHost,
  type SuggestionHostLease,
  type SuggestionKey,
  type SuggestionKeyBindings,
  type SuggestionMenu,
  type SuggestionMenuSnapshot,
  type SuggestionRetreat,
} from "./suggestion-menu-store";
export {
  filterWikilinkItems,
  type WikilinkCatalog,
  type WikilinkDocument,
  type WikilinkMenuItem,
} from "./wikilink-catalog";
