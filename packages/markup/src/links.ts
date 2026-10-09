/**
 * Public entry `@meridian/markup/links`: the shared link rules (holder scope,
 * pass-3 assignment, written addresses) and the ProseMirror occurrence walk.
 * Loads neither the codecs nor Yjs, so the client's assignment path stays small.
 */
export {
  assignFreshLink,
  classifyWrittenHref,
  createHolderLinkScope,
  type FreshAssignment,
  type HolderCatalog,
  type HolderLinkScope,
  type WrittenGrammar,
  writtenAddresses,
  writtenSourceUri,
} from "./holder-link-scope.js";
export {
  type LinkOccurrence,
  type OccurrencePath,
  type SpelledLinkFact,
  spelledLinks,
  walkLinkOccurrences,
} from "./link-occurrences.js";
