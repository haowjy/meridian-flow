/** Public codec, plugin, and context contracts for @meridian/markup. */

import type { Node as PMNode, Schema } from "prosemirror-model";
import type { PluggableList } from "unified";

import type { MdastRoot } from "./ast.js";
import type { CodecParseErrorLocation } from "./error.js";

export type { CodecParseErrorLocation, PMNode };

/** Stable asset identity ↔ current project-relative path translation boundary. */
export interface AssetPathResolver {
  /** Return the current (or tombstoned last-known) path for an asset document. */
  pathForAsset(assetDocumentId: string): string;
  /** Return an asset document id only for a path known to the current project. */
  assetForPath(path: string): string | null;
}

/** ProseMirror mark attribute bag — JSON-serializable values only. */
export type MarkAttrs = Record<string, unknown>;

/** Result of parsing text content into ProseMirror nodes. */
export interface ParsedContent {
  blocks: PMNode[];
}

/** Context threaded through block/mark serialize calls. */
export interface SerializeContext {
  schema: Schema;
  assetPathResolver: AssetPathResolver;
}

/** Context threaded through block/mark parse calls. */
export interface ParseContext {
  schema: Schema;
  assetPathResolver: AssetPathResolver;
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
  postParse?: (root: MdastRoot) => MdastRoot;
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
  parse(content: string): ParsedContent;
  serialize(blocks: PMNode[]): string;
  serializeBlock(block: PMNode): string;
  serializeBlocks(blocks: readonly PMNode[]): string[];
}
