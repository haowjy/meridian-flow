import type { Fragment } from "prosemirror-model";
import type { Block } from "../codec-types.js";
import type { LoroBlock } from "./loro-model.js";

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
  /** The mark's name. */
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
 * An opaque key for the editor that typed a unit: a Loro peer, one per editing session (each AI
 * write gets a fresh one), so equal keys mean one session typed both units, not one person.
 */
export type EditorOf = (unit: number) => string | undefined;

/** One top-level block, aligned across its handle, identity, display hash and node. */
export interface ProjectedBlock {
  ref: LoroBlock;
  /** The block's identity in its document, for pairing cuts: its Loro `id`. */
  key: string;
  /** Display hash, unique among the projected blocks and origin-aware. */
  hash: string;
  /** Immutable full hash behind `hash`, origin-aware; what a held hash prefix resolves against. */
  fullHash: string;
  node: Block;
}
