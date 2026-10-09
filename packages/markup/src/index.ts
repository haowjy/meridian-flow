/** Public API for canonical Markdown/MDX codecs and the shared link rules (scope, pass 3, stored-link walks). */

export type * from "./ast.js";
export type { ComponentRegistry, ComponentSpec, EditorSpec, PropSpec } from "./components.js";
export { builtInComponents, documentComponentRegistry } from "./components.js";
export { UNSCOPED_DOCUMENT_LINKS } from "./document-link-scope.js";
export { CodecParseError } from "./error.js";
export {
  inlineContentToMdast,
  invalidJsxFallback,
  parseBlockAst,
  parseBlockChildren,
  parseInlineChildren,
  pmBlockChildrenToMdast,
  rawTextForAst,
  rawTextParagraph,
  stringifyBlock,
} from "./helpers.js";
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
export { markdownCodec } from "./markdown/index.js";
export { formatMarkdownLink } from "./markdown/marks/link.js";
export { mdxCodec } from "./mdx/index.js";
export {
  extractStoredLinks,
  type StoredLinkKeys,
  type StoredLinkOccurrence,
  storedLinkKeys,
} from "./stored-links.js";
export type {
  BlockCodec,
  BuildOptions,
  CodecParseErrorLocation,
  DocumentLinkScope,
  MarkAttrs,
  MarkCodec,
  MarkupCodec,
  OccurrenceSpan,
  ParseContext,
  ParsedContent,
  ParsedContentWithSpans,
  PMNode,
  SerializeContext,
  SpelledHref,
} from "./types.js";
