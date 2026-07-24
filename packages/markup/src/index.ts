/** Public API for the composable text ↔ ProseMirror markup codec. */

export { createAssetPathResolver, unresolvedAssetPathResolver } from "./asset-path-resolver.js";
export type * from "./ast.js";
export { createMarkupCodec, requiredBlockNamesForSchema } from "./codec.js";
export type { ComponentRegistry, ComponentSpec, EditorSpec, PropSpec } from "./components.js";
export { builtInComponents, documentComponentRegistry } from "./components.js";
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
  AssetPathResolver,
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
