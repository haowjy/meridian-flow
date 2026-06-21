import type * as Y from "yjs";

import type { ParsedContent, Span } from "../codec/types.js";

/**
 * Pluggable document model — carries block semantics and apply routing.
 * The y-prosemirror implementation lives in model/y-prosemirror.ts (Step 5).
 */
export interface DocumentModel<Block> {
  /** Get all top-level blocks from the Yjs document. */
  getBlocks(doc: Y.Doc): Block[];

  /** Derive a stable hash from a block's CRDT item ID. */
  getBlockId(block: Block): string;

  /** Get the text content of a block (for find/match). */
  getText(block: Block): string;

  /**
   * Apply a text edit within a block (Tier 1 / Tier 2 routing).
   * Mutates doc in place; span must refer to valid offsets in getText(block).
   */
  applyTextEdit(doc: Y.Doc, block: Block, span: Span, newText: string): void;

  /**
   * Insert new blocks after a reference block (Tier 3).
   * When after is null, inserts at document start. Returns the inserted blocks.
   */
  insertBlocks(doc: Y.Doc, after: Block | null, parsed: ParsedContent): Block[];

  /**
   * Delete a block (Tier 3). Clears text instead of removing when it is the last block.
   */
  deleteBlock(doc: Y.Doc, block: Block): void;
}
