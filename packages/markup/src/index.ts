/**
 * Public API for canonical Markdown/MDX codecs. The shared link rules live at
 * `@meridian/markup/links` and the Yjs stored-link walks at
 * `@meridian/markup/stored-links`, so neither drags the other (or the codecs) in.
 */

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
export { markdownCodec } from "./markdown/index.js";
export { formatMarkdownLink } from "./markdown/marks/link.js";
export { mdxCodec } from "./mdx/index.js";
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
