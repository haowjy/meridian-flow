/** Public API for canonical Markdown/MDX codecs and asset/wikilink helpers. */

export { createAssetPathResolver, unresolvedAssetPathResolver } from "./asset-path-resolver.js";
export type * from "./ast.js";
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
export { markdownCodec } from "./markdown/index.js";
export { remarkWikiLink } from "./markdown/wikilink.js";
export { formatWikilink, wikilinkTarget } from "./markdown/wikilink-target.js";
export { mdxCodec } from "./mdx/index.js";
export type {
  AssetPathResolver,
  BlockCodec,
  BuildOptions,
  CodecParseErrorLocation,
  MarkAttrs,
  MarkCodec,
  MarkupCodec,
  ParseContext,
  ParsedContent,
  PMNode,
  SerializeContext,
} from "./types.js";
