// Structural document-model port for the agent editing core.

import type { ParsedContent } from "@meridian/markup";
import type { AgentEditCodec } from "../codec-adapter.js";
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

export type BlockLookup =
  | { ok: true; block: BlockRef }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; matches: BlockRef[] };

export type InlineReplacementResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid_write" | "not_found";
      message: string;
      details?: Record<string, unknown>;
    };

export interface InlineTextReplacement {
  span: Span;
  newText: string;
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

  /** Resolve an agent-visible block hash against the current document. */
  lookupBlock(doc: DocHandle, hash: string): BlockLookup;

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
  /** Nonempty text delta runs, including nested blocks; undo repair skips more than one. */
  inlineRunCount(block: BlockRef): number;

  /** Apply disjoint same-block replacements through one adapter-owned ProseMirror transform. */
  applyInlineReplacements(
    doc: DocHandle,
    block: BlockRef,
    replacements: readonly InlineTextReplacement[],
    codec: AgentEditCodec,
  ): InlineReplacementResult;

  /** Replace one same-type block's complete content while preserving its CRDT parent identity. */
  applyBlockReplacement(doc: DocHandle, block: BlockRef, replacement: Block): void;

  /** Adapter-owned block projection for codec-bound residual paths. */
  projectBlocks(doc: DocHandle): Block[];

  /** Hash-prefixed block lines for agent-facing document views and echo. */
  serializeBlockLines(
    doc: DocHandle,
    codec: AgentEditCodec,
    blocks?: readonly BlockRef[],
  ): string[];

  /** Hashless block bodies for resolver matching. */
  serializeBlockBodies(
    doc: DocHandle,
    codec: AgentEditCodec,
    blocks: readonly BlockRef[],
  ): string[];
}
