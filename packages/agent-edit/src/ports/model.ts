// Structural document-model port for the agent editing core.

import type { ParsedContent } from "@meridian/markup";
import type { BlockRef } from "../block-ref.js";
import type { Block, Span } from "../codec-types.js";
import type { DocHandle } from "../doc-handle.js";

export interface TextRun {
  start: number;
  length: number;
  attrsKey: string;
}

export type BlockLookup =
  | { ok: true; hash: string; block: BlockRef }
  | { ok: false; reason: "not_found" | "ambiguous"; matches?: BlockRef[] };

/**
 * Block-operation seam carrying block semantics and Tier 1/3 apply routing.
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

  /** Run a document transaction with the adapter/runtime's native origin. */
  transact(doc: DocHandle, fn: () => void, origin: unknown): void;

  /**
   * Apply a text edit within a block (Tier 1 / Tier 2 routing).
   * Mutates doc in place; span must refer to valid offsets in getText(block).
   */
  applyTextEdit(doc: DocHandle, block: BlockRef, span: Span, newText: string): void;

  /**
   * Insert new blocks after a reference block (Tier 3).
   * When after is null, inserts at document start. Returns the inserted blocks.
   */
  insertBlocks(doc: DocHandle, after: BlockRef | null, parsed: ParsedContent): BlockRef[];

  /**
   * Delete a block (Tier 3). Clears text instead of removing when it is the last block.
   */
  deleteBlock(doc: DocHandle, block: BlockRef): void;
}

/**
 * Full structural model surface required by @meridian/agent-edit's write tool.
 * Hosts may provide any implementation that satisfies this port; the built-in
 * y-prosemirror adapter is only one implementation.
 */
export interface AgentEditModel extends DocumentModel {
  /** Neutral inline mark runs for Tier 1-vs-Tier 2 text edit selection. */
  inlineRuns(block: BlockRef): TextRun[];

  /** Project a live block into the codec's block representation. */
  toProsemirrorBlock(doc: DocHandle, block: BlockRef): Block;

  /** Batch version of toProsemirrorBlock — projects the PM tree once for all blocks. */
  toProsemirrorBlocks(doc: DocHandle): Block[];

  /** Replace a live block with an already-planned codec block projection. */
  applyBlockDiff(doc: DocHandle, block: BlockRef, replacement: Block): void;
}
