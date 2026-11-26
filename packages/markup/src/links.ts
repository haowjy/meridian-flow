export {
  type AssetAddress,
  assignFreshLink,
  createHolderLinkScope,
  type FreshAssignment,
  type HolderCatalog,
  type HolderLinkScope,
  qualifyWrittenHref,
  settledAheads,
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
