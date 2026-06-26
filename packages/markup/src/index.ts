/** Public API for the composable text ↔ ProseMirror markup codec. */

export type * from "./ast.js";
export { createMarkupCodec, requiredBlockNamesForSchema } from "./codec.js";
export type { ComponentRegistry, ComponentSpec, EditorSpec, PropSpec } from "./components.js";
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
export { markdown, markdownCodec } from "./markdown/index.js";
export { mdx, mdxCodec } from "./mdx/index.js";
export type {
  BlockCodec,
  BuildOptions,
  CodecParseErrorLocation,
  MarkAttrs,
  MarkCodec,
  MarkupCodec,
  MarkupCodecBuilder,
  MarkupPlugin,
  ParseContext,
  ParsedContent,
  PMNode,
  SerializeContext,
} from "./types.js";
