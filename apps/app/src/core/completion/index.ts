/** Completion: the headless half of every menu a writer types underneath. */

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
  referenceUriForAuthority,
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
