import type { Node as PMNode, Schema } from "prosemirror-model";

import type { ComponentRegistry } from "../registry/component-registry.js";

export type { PMNode };

/** Top-level block unit passed to codec serialization (typically a PM block node). */
export type Block = PMNode;

/** ProseMirror mark attribute bag — JSON-serializable values only. */
export type MarkAttrs = Record<string, unknown>;

/** Character offsets within a block's plain text (for find/match and Tier 1 edits). */
export interface Span {
  from: number;
  to: number;
}

/** Result of parsing agent-written content into ProseMirror nodes. */
export interface ParsedContent {
  blocks: PMNode[];
}

export interface CodecParseErrorLocation {
  line?: number;
  column?: number;
}

/** Typed, catchable parse failure for syntactically invalid markdown/MDX input. */
export class CodecParseError extends Error {
  readonly line?: number;
  readonly column?: number;

  constructor(message: string, location: CodecParseErrorLocation = {}, cause?: unknown) {
    super(message, { cause });
    this.name = "CodecParseError";
    this.line = location.line;
    this.column = location.column;
  }
}

/** Context threaded through block/mark serialize calls. */
export interface SerializeContext {
  schema: Schema;
  /** Registered MDX components — used when serializing jsx_leaf/jsx_container. */
  components?: ComponentRegistry;
}

/** Context threaded through block/mark parse calls. */
export interface ParseContext {
  schema: Schema;
  /** Registered MDX components — validates props on parse/apply. */
  components?: ComponentRegistry;
}

/** Block-level: one registration per PM block node type. */
export interface BlockCodec<ASTNode = unknown> {
  /** ProseMirror node type name this handles. */
  name: string;

  /** PM node → serialized string the agent sees. */
  serialize(node: PMNode, ctx: SerializeContext): string;

  /** Parsed AST node → PM node (return null to skip). */
  parse(ast: ASTNode, ctx: ParseContext): PMNode | null;
}

/** Mark-level: one registration per PM mark type. */
export interface MarkCodec<ASTNode = unknown> {
  /** ProseMirror mark type name this handles. */
  name: string;

  /** Mark attrs → inline syntax (e.g. strong → **). */
  serialize(text: string, attrs: MarkAttrs, ctx: SerializeContext): string;

  /** Inline AST node → mark attrs (return null to skip). */
  parse(ast: ASTNode, ctx: ParseContext): MarkAttrs | null;
}

/** Assembled codec — built from block + mark registrations. */
export interface Codec {
  blocks: BlockCodec[];
  marks: MarkCodec[];

  /** Serialize full document or block list. */
  serialize(blocks: Block[], opts?: { hashes: boolean }): string;

  /** Parse agent-written content into PM nodes. */
  parse(content: string): ParsedContent;

  /** Serialize a single block with hash prefix for echo/view. */
  serializeBlock(block: Block, hash: string): string;

  /** Batch version of serializeBlock — one runtime allocation for all blocks. */
  serializeBlocks(blocks: readonly Block[], hashes: readonly string[]): string[];

  /** Serialize block bodies without hash prefixes for resolver/find matching. */
  serializeBlockBodies(blocks: readonly Block[]): string[];
}
