// Structural document-model port for the agent editing core.

import type { ParsedContent } from "@meridian/markup";
import type { Fragment } from "prosemirror-model";
import type { Block, Span } from "../codec-types.js";
import type { BlockRef, DocHandle } from "../handles.js";

export interface CanonicalBlockIdentity {
  clientID: number;
  clock: number;
}

export interface ContentLineage {
  clientID: number;
  clock: number;
  length: number;
}

export type InlineReplacementResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid_write" | "not_found";
      message: string;
      details?: Record<string, unknown>;
    };

/** Inline nodes, applied as given, that replace one plain-text span. */
export interface InlineTextReplacement {
  span: Span;
  content: Fragment;
}

/**
 * Block-operation seam carrying block semantics and the plain-text and structural mutation verbs.
 *
 * The seam is expressed in opaque handles. Adapters own the concrete CRDT/content
 * objects behind DocHandle and BlockRef; resolver/apply code only preserves
 * identity and asks this port for model operations.
 */
export interface DocumentModel {
  /** Get all top-level blocks from the document. */
  getBlocks(doc: DocHandle): BlockRef[];

  /** Derive a stable hash for one already-known block. */
  getBlockId(block: BlockRef): string;

  /** Full immutable identity used by provenance and trail authority. */
  getCanonicalBlockIdentity(block: BlockRef): CanonicalBlockIdentity;

  /** Canonical ordered hash list for a full document. */
  getDocumentBlockIds(doc: DocHandle): string[];

  /** True when the block reference still points at a live integrated block. */
  isLive(block: BlockRef): boolean;

  /** Adapter block type name (for structural resolver/apply decisions). */
  getBlockType(block: BlockRef): string;

  /** Heading level when this block is a heading; undefined otherwise. */
  getHeadingLevel(block: BlockRef): number | undefined;

  /** Get the text content of a block (for find/match). */
  getText(block: BlockRef): string;

  /** Immutable CRDT identities for the currently visible prose units in this block. */
  getVisibleContentLineage(block: BlockRef): ContentLineage[];

  /** Run a document transaction with the adapter/runtime's native origin. */
  transact(doc: DocHandle, fn: () => void, origin: unknown): void;

  /** Encode the document's current CRDT state vector (sync cursor). */
  encodeStateVector(doc: DocHandle): Uint8Array;

  /** Apply a concurrent CRDT update with its persisted origin metadata. */
  applyUpdate(doc: DocHandle, update: Uint8Array, origin: unknown): void;

  /**
   * Replace plain text within a block, keeping unchanged text at the span's edges.
   * Undo repair's verb; agent writes go through `applyInlineReplacements`.
   * Mutates doc in place; span must refer to valid offsets in getText(block).
   */
  applyTextEdit(doc: DocHandle, block: BlockRef, span: Span, newText: string): void;

  /**
   * Insert new blocks after a reference block.
   * When after is null, inserts at document start. Returns the inserted blocks.
   */
  insertBlocks(doc: DocHandle, after: BlockRef | null, parsed: ParsedContent): BlockRef[];

  /**
   * Delete a block. Clears text instead of removing when it is the last block.
   */
  deleteBlock(doc: DocHandle, block: BlockRef): void;
}

/**
 * Full structural model surface required by @meridian/agent-edit's write tool.
 * Hosts may provide any implementation that satisfies this port; the built-in
 * y-prosemirror adapter is only one implementation.
 */
export interface AgentEditModel extends DocumentModel {
  /** Apply exact disjoint same-block replacements without trimming common edge characters. */
  applyInlineReplacements(
    doc: DocHandle,
    block: BlockRef,
    replacements: readonly InlineTextReplacement[],
  ): InlineReplacementResult;

  /** Replace one same-type block's complete content while preserving its CRDT parent identity. */
  applyBlockReplacement(doc: DocHandle, block: BlockRef, replacement: Block): void;

  /**
   * Every top-level block with its display hash and ProseMirror node, built in one walk so
   * `ref`, `id`, `hash` and `node` always describe the same block.
   *
   * Projects on the document it is given. An element the schema can't build is deleted from
   * that document (y-prosemirror's repair) and left out of the result, so callers must hand
   * over a private copy (one no other peer writes to), never a shared document. Hashes cover the surviving
   * blocks only.
   */
  projectBlocks(doc: DocHandle): ProjectedBlock[];
}

/** One top-level block, aligned across its handle, identity, display hash and node. */
export interface ProjectedBlock {
  ref: BlockRef;
  /** The block's own CRDT item id (what `getCanonicalBlockIdentity` returns). */
  id: CanonicalBlockIdentity;
  /** Display hash, unique among the projected blocks and origin-aware. */
  hash: string;
  /** Immutable full hash behind `hash`, origin-aware; what a held hash prefix resolves against. */
  fullHash: string;
  node: Block;
}
