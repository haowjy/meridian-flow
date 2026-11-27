import type { ParsedContent } from "@meridian/markup";
import type { Fragment } from "prosemirror-model";
import type { Block } from "../codec-types.js";
import type { BlockRef, DocHandle } from "../handles.js";

export interface TextSplice {
  from: number;
  to: number;
  content: Fragment;
}

export interface FormatRange {
  from: number;
  to: number;
  mark: string;
  attrs: Record<string, unknown> | null;
}

export type EditOp =
  | { kind: "text"; path: readonly number[]; splices: TextSplice[]; formats: FormatRange[] }
  | {
      kind: "insert";
      path: readonly number[];
      after: number;
      nodes: readonly Block[];
    }
  | { kind: "delete"; path: readonly number[] }
  | {
      kind: "attrs";
      path: readonly number[];
      attrs: Record<string, unknown>;
      unit?: number;
    };

type EditOpsResult = { ok: true } | { ok: false; code: "invalid_write"; message: string };

export interface DocumentModel {
  getBlocks(doc: DocHandle): BlockRef[];

  getBlockId(block: BlockRef): string;

  getDocumentBlockIds(doc: DocHandle): string[];

  isLive(block: BlockRef): boolean;

  getBlockType(block: BlockRef): string;

  getHeadingLevel(block: BlockRef): number | undefined;

  getText(block: BlockRef): string;

  transact(doc: DocHandle, fn: () => void, origin: unknown): void;

  insertBlocks(doc: DocHandle, after: BlockRef | null, parsed: ParsedContent): BlockRef[];

  deleteBlock(doc: DocHandle, block: BlockRef): void;

  recordPieces(doc: DocHandle, a: BlockRef, b: BlockRef): void;
}

export type EditorOf = (unit: number) => string | undefined;

export interface AgentEditModel extends DocumentModel {
  applyOps(doc: DocHandle, block: BlockRef, ops: readonly EditOp[]): EditOpsResult;

  unitEditors(block: BlockRef, path: readonly number[]): EditorOf;

  /**
   * Every top-level block with its display hash and ProseMirror node, built in one walk so
   * `ref`, `id`, `hash` and `node` always describe the same block.
   *
   * Projects on the document it is given. Hashes cover the blocks it returns.
   */
  projectBlocks(doc: DocHandle): ProjectedBlock[];
}

export interface ProjectedBlock {
  ref: BlockRef;
  key: string;
  hash: string;
  fullHash: string;
  node: Block;
}
