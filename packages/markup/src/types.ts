import type { SpelledHref } from "@meridian/contracts";
import type { Node as PMNode, Schema } from "prosemirror-model";
import type { PluggableList } from "unified";

import type { MdastRoot } from "./ast.js";
import type { CodecParseErrorLocation } from "./error.js";
import type { PreparedSource } from "./prepared-source.js";
import type { SerializedBlock } from "./serialize-nested.js";

export type { CodecParseErrorLocation, PMNode, SerializedBlock, SpelledHref };

/**
 * Synchronous spelling for one holder in one view, over a snapshot prepared
 * before the call. Serialization asks it for every link, image and figure
 * destination; the stored `ref` never reaches the wire, only what this spells.
 */
export interface DocumentLinkScope {
  spellLink(attrs: { href: string; ref: string | null }): SpelledHref;
  /**
   * `asset:` rule first (the upload's path, else its last full address, else
   * an empty destination; never the id), then ref spelling under the
   * manuscript-root grammar, then stored src.
   */
  spellSource(attrs: { src: string; ref: string | null }): SpelledHref;
}

export type MarkAttrs = Record<string, unknown>;

export interface ParsedContent {
  blocks: PMNode[];
}

export interface ParseOptions {
  within?: string | null;
}

export interface OccurrenceSpan {
  start: number;
  end: number;
}

/**
 * Parsed blocks plus one span per `walkLinkOccurrences(blocks)` entry, in the
 * same order. A link, image or figure gets its own source position; an
 * occurrence the codec cannot place precisely (inside a raw-HTML table, or
 * text the ingress preprocessor rewrote) gets a span enclosing it.
 */
export interface ParsedContentWithSpans extends ParsedContent {
  spans: OccurrenceSpan[];
}

export interface SerializeContext {
  schema: Schema;
  links: DocumentLinkScope;
  leadsQuote?: boolean;
}

export interface ParseContext {
  schema: Schema;
}

export interface BlockCodec<ASTNode = unknown> {
  name: string;

  serialize(node: PMNode, ctx: SerializeContext): string;

  parse(ast: ASTNode, ctx: ParseContext): PMNode | null;
}

export interface MarkCodec<ASTNode = unknown> {
  name: string;

  serialize(text: string, attrs: MarkAttrs, ctx: SerializeContext): string;

  parse(ast: ASTNode, ctx: ParseContext): MarkAttrs | null;
}

export interface MarkupPlugin {
  blocks?: readonly BlockCodec[];
  marks?: readonly MarkCodec[];
  remarkPlugins?: PluggableList;
  preprocess?: (text: string) => string | PreparedSource;
  postParse?: (root: MdastRoot, source: string) => MdastRoot;
  postSerializeBlock?: (node: PMNode, serialized: string, ctx: SerializeContext) => string;
}

export interface BuildOptions {
  export?: boolean;
  requireSchemaBlockCoverage?: boolean;
  requiredBlockNames?: readonly string[];
}

export interface MarkupCodecBuilder {
  use(plugin: MarkupPlugin): this;
  build(options?: BuildOptions): MarkupCodec;
}

export interface MarkupCodec {
  parse(content: string, options?: ParseOptions): ParsedContent;
  parseWithSpans(content: string, options?: ParseOptions): ParsedContentWithSpans;
  parseWithSourceMap(content: string): ParsedContentWithSourceMap;
  serialize(blocks: PMNode[], links: DocumentLinkScope): string;
  serializeBlock(block: PMNode, links: DocumentLinkScope): string;
  serializeBlocks(blocks: readonly PMNode[], links: DocumentLinkScope): SerializedBlock[];
  parseStreaming(content: string, options?: MarkdownStreamOptions): MarkdownStreamResult;
}

export interface MarkdownStreamOptions {
  repair?: boolean;
}

export interface MarkdownStreamResult {
  readonly blocks: readonly PMNode[];
  readonly openCode: PMNode | null;
}

export interface SourceRange {
  from: number;
  to: number;
}
export interface PresentationSourceRun {
  kind: "text" | "link";
  at: { block: number; path: number[]; count: number; offset?: number };
  source: SourceRange | null;
}
export interface ParsedContentWithSourceMap extends ParsedContent {
  sourceMap: PresentationSourceRun[];
  openCode: PMNode | null;
}
