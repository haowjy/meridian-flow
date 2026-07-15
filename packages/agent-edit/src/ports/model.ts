// Structural document-model port for the agent editing core.

import type { ParsedContent } from "@meridian/markup";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block, Span } from "../codec-types.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { CanonicalBlockIdentity } from "./observation-snapshot.js";

export interface TextRun {
  start: number;
  length: number;
  attrsKey: string;
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

  /** Full immutable identity used by response observation authority. */
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

  /** Run a document transaction with the adapter/runtime's native origin. */
  transact(doc: DocHandle, fn: () => void, origin: unknown): void;

  /** Encode the document's current CRDT state vector (sync cursor). */
  encodeStateVector(doc: DocHandle): Uint8Array;

  /** Apply a concurrent CRDT update with its persisted origin metadata. */
  applyUpdate(doc: DocHandle, update: Uint8Array, origin: unknown): void;

  /** True if `after` reflects CRDT progress past `before`. */
  stateVectorAdvanced(before: Uint8Array, after: Uint8Array): boolean;

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

  /** True when parsed replacement markup can use the Tier 1 flat-text path. */
  isPlainTextReplacement(parsed: ParsedContent, source: string): boolean;

  /** Tier 2 formatted text replacement; adapters own codec projection and tree diffing. */
  applyInlineReplacement(
    doc: DocHandle,
    block: BlockRef,
    span: Span,
    replacementMarkup: string,
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
