/** Public codec, plugin, and context contracts for @meridian/markup. */

import type { SpelledHref } from "@meridian/contracts";
import type { Node as PMNode, Schema } from "prosemirror-model";
import type { PluggableList } from "unified";

import type { MdastRoot } from "./ast.js";
import type { CodecParseErrorLocation } from "./error.js";

export type { CodecParseErrorLocation, PMNode, SpelledHref };

/**
 * Synchronous spelling for one holder in one view, over a snapshot prepared
 * before the call. Serialization asks it for every link, image and figure
 * destination; the stored `ref` never reaches the wire, only what this spells.
 */
export interface DocumentLinkScope {
  spellLink(attrs: { href: string; ref: string | null }): SpelledHref;
  /**
   * `asset:` rule first (the upload's path, shown at its manuscript address),
   * then ref spelling under the manuscript-root grammar, then stored src.
   */
  spellSource(attrs: { src: string; ref: string | null }): SpelledHref;
}

/** ProseMirror mark attribute bag — JSON-serializable values only. */
export type MarkAttrs = Record<string, unknown>;

/** Result of parsing text content into ProseMirror nodes. */
export interface ParsedContent {
  blocks: PMNode[];
}

/** Where one link occurrence was written, as offsets into the parsed text. */
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

/** Context threaded through block/mark serialize calls. */
export interface SerializeContext {
  schema: Schema;
  links: DocumentLinkScope;
}

/** Context threaded through block/mark parse calls. */
export interface ParseContext {
  schema: Schema;
}

/** Block-level: one registration per PM block node type. */
export interface BlockCodec<ASTNode = unknown> {
  /** ProseMirror node type name this handles. */
  name: string;

  /** PM node → serialized markdown/MDX body. */
  serialize(node: PMNode, ctx: SerializeContext): string;

  /** Parsed AST node → PM node (return null to skip/delegate). */
  parse(ast: ASTNode, ctx: ParseContext): PMNode | null;
}

/** Mark-level: one registration per PM mark type. */
export interface MarkCodec<ASTNode = unknown> {
  /** ProseMirror mark type name this handles. */
  name: string;

  /** Mark attrs → inline syntax wrapper. */
  serialize(text: string, attrs: MarkAttrs, ctx: SerializeContext): string;

  /** Inline AST node → mark attrs (return null to skip). */
  parse(ast: ASTNode, ctx: ParseContext): MarkAttrs | null;
}

/** A plugin bundles codecs with parser configuration and processing hooks. */
export interface MarkupPlugin {
  blocks?: readonly BlockCodec[];
  marks?: readonly MarkCodec[];
  remarkPlugins?: PluggableList;
  preprocess?: (text: string) => string;
  /** Receives the preprocessed source matching AST positions, including internal reparses. */
  postParse?: (root: MdastRoot, source: string) => MdastRoot;
  /** Format-specific wrapping applied after a block's ordinary codec. */
  postSerializeBlock?: (node: PMNode, serialized: string, ctx: SerializeContext) => string;
}

export interface BuildOptions {
  requireSchemaBlockCoverage?: boolean;
  requiredBlockNames?: readonly string[];
}

export interface MarkupCodecBuilder {
  use(plugin: MarkupPlugin): this;
  build(options?: BuildOptions): MarkupCodec;
}

/** Assembled text ↔ ProseMirror codec. */
export interface MarkupCodec {
  /** Pure syntax: every link `ref` is null and every href is as written. */
  parse(content: string): ParsedContent;
  parseWithSpans(content: string): ParsedContentWithSpans;
  serialize(blocks: PMNode[], links: DocumentLinkScope): string;
  serializeBlock(block: PMNode, links: DocumentLinkScope): string;
  serializeBlocks(blocks: readonly PMNode[], links: DocumentLinkScope): string[];
}
