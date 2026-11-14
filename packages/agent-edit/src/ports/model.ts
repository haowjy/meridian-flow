// Structural document-model port for the agent editing core.

import type { ParsedContent } from "@meridian/markup";
import type { Fragment } from "prosemirror-model";
import type { Block } from "../codec-types.js";
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

/**
 * Replace units `[from, to)` of one textblock with inline `content`, applied as given.
 * `content` may hold inline atoms (a line break, an image); one that lands inside a run of
 * text splits the run.
 */
export interface TextSplice {
  from: number;
  to: number;
  content: Fragment;
}

/** Set (`attrs`) or clear (`null`) one mark over units `[from, to)` of one textblock. */
export interface FormatRange {
  from: number;
  to: number;
  mark: string;
  attrs: Record<string, unknown> | null;
}

/**
 * The smallest changes to one top-level block, each addressed to a node the model saw.
 * `path` is child indexes from that block down to the node, in the model's view; a unit
 * is one inline position of a textblock (a UTF-16 code unit of text, or an inline atom).
 */
export type EditOp =
  | { kind: "text"; path: readonly number[]; splices: TextSplice[]; formats: FormatRange[] }
  | {
      /** `nodes` go into the container at `path`, after its child `after` (-1: first). */
      kind: "insert";
      path: readonly number[];
      after: number;
      nodes: readonly Block[];
    }
  /** The node at `path` goes, with everything in it. */
  | { kind: "delete"; path: readonly number[] }
  | {
      kind: "attrs";
      path: readonly number[];
      attrs: Record<string, unknown>;
      /** Set for an inline atom: its unit in the textblock at `path`. */
      unit?: number;
    };

export type EditOpsResult = { ok: true } | { ok: false; code: "invalid_write"; message: string };

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

  /** Full immutable identity used by provenance. */
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

  /**
   * Identities of the text in units [from, to) of the textblock at `path` under `block`, in
   * the model's view; an inline atom is a unit with no identity.
   */
  textblockLineage(
    block: BlockRef,
    path: readonly number[],
    from: number,
    to: number,
  ): ContentLineage[];

  /** Immutable CRDT identities of the visible text under the node at `path` under `block`. */
  nodeLineage(block: BlockRef, path: readonly number[]): ContentLineage[];

  /** Run a document transaction with the adapter/runtime's native origin. */
  transact(doc: DocHandle, fn: () => void, origin: unknown): void;

  /** Encode the document's current CRDT state vector (sync cursor). */
  encodeStateVector(doc: DocHandle): Uint8Array;

  /** Apply a concurrent CRDT update with its persisted origin metadata. */
  applyUpdate(doc: DocHandle, update: Uint8Array, origin: unknown): void;

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
  /**
   * Apply operations to one top-level block, addressed on its state before any of them.
   * Every path and offset is checked before anything changes; a write that does not fit
   * the block fails and leaves it as it was. An edited block keeps its element and its id;
   * an inserted node keeps an id it already has and takes a new one otherwise.
   */
  applyOps(doc: DocHandle, block: BlockRef, ops: readonly EditOp[]): EditOpsResult;

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
