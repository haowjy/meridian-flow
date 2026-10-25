/**
 * Public entry `@meridian/markup/links`: the shared link rules (holder scope,
 * pass-3 assignment, written addresses) and the ProseMirror occurrence walk.
 * Loads neither the codecs nor Yjs, so the client's assignment path stays small.
 */
export {
  type AssetAddress,
  assignFreshLink,
  createHolderLinkScope,
  type FreshAssignment,
  type HolderCatalog,
  type HolderLinkScope,
  qualifyWrittenHref,
  UNSPELLED_UPLOAD,
  type WrittenGrammar,
  writtenAddresses,
  writtenSourceTarget,
} from "./holder-link-scope.js";
export {
  type LinkOccurrence,
  type OccurrencePath,
  occurrenceIdentity,
  type SpelledLinkFact,
  spelledFact,
  spelledLinks,
  walkLinkOccurrences,
} from "./link-occurrences.js";
export { formatMarkdownLink, markdownLinkDestination } from "./markdown/marks/link.js";
