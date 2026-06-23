// Structural document-model port for the agent editing core.
import type * as Y from "yjs";

import type { Block, ParsedContent, Span } from "../codec/types.js";

/**
 * Block-operation seam carrying block semantics and Tier 1/3 apply routing.
 * This is the intended swap point for eventually editing non-ProseMirror Yjs
 * documents — but that is NOT YET realized: today the only implementation is
 * y-prosemirror (`model/y-prosemirror.ts`) and the apply core still calls
 * ProseMirror-specific operations, so full content-model swappability is
 * deferred. Keep this generic over `BlockNode` so the seam stays viable; see
 * deferred GH issue #70 (generic Yjs edit core).
 */
export interface DocumentModel<BlockNode> {
  /** Get all top-level blocks from the Yjs document. */
  getBlocks(doc: Y.Doc): BlockNode[];

  /** Derive a stable hash from a block's CRDT item ID. */
  getBlockId(block: BlockNode): string;

  /** Get the text content of a block (for find/match). */
  getText(block: BlockNode): string;

  /**
   * Apply a text edit within a block (Tier 1 / Tier 2 routing).
   * Mutates doc in place; span must refer to valid offsets in getText(block).
   */
  applyTextEdit(doc: Y.Doc, block: BlockNode, span: Span, newText: string): void;

  /**
   * Insert new blocks after a reference block (Tier 3).
   * When after is null, inserts at document start. Returns the inserted blocks.
   */
  insertBlocks(doc: Y.Doc, after: BlockNode | null, parsed: ParsedContent): BlockNode[];

  /**
   * Delete a block (Tier 3). Clears text instead of removing when it is the last block.
   */
  deleteBlock(doc: Y.Doc, block: BlockNode): void;
}

/**
 * Full structural model surface required by @meridian/agent-edit's write tool.
 * Hosts may provide any implementation that satisfies this port; the built-in
 * y-prosemirror adapter is only one implementation.
 */
export interface AgentEditModel extends DocumentModel<Y.XmlElement> {
  /** Project a live Yjs block into the codec's block representation. */
  toProsemirrorBlock(doc: Y.Doc, block: Y.XmlElement): Block;

  /** Replace a live Yjs block with an already-planned codec block projection. */
  applyBlockDiff(doc: Y.Doc, block: Y.XmlElement, replacement: Block): void;
}
