import type * as Y from "yjs";

import type { ParsedContent, Span } from "../codec/types.js";

/**
 * Block-operation seam carrying block semantics and Tier 1/3 apply routing.
 * This is the intended swap point for eventually editing non-ProseMirror Yjs
 * documents — but that is NOT YET realized: today the only implementation is
 * y-prosemirror (`model/y-prosemirror.ts`) and the apply core still calls
 * ProseMirror-specific operations (schema-aware parse via the codec, Tier-2 block
 * diff), so full content-model swappability is deferred. Keep this generic over
 * `Block` so the seam stays viable; see deferred GH issue #70 (generic Yjs edit core).
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
