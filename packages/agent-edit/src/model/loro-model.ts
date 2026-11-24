// agent-edit's document model over a Loro room copy (design §1, §5): blocks are the normalized read,
// a block's identity is its `id`, and every write is `applyOps` on the copy, committed by the
// write's author.
import {
  applyOps as applyShapeOps,
  type BlockId,
  COMMENT_MARK,
  COMMENT_STYLE_PREFIX,
  type RoomDocs,
  readDocument,
  type ShapeBlock,
  type ShapeOp,
  unitEditors,
  type WriteOptions,
} from "@meridian/document-model";
import { blocksOf, inlineOf, nodeOf } from "@meridian/loro-prosemirror";
import type { ParsedContent } from "@meridian/markup";
import { newBlockId, withBlockIds, withoutBlockIds } from "@meridian/prosemirror-schema";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { fullHashForBlockId, uniqueHashPrefixes } from "./block-hash.js";
import type { EditOp, EditOpsResult, EditorOf, ProjectedBlock } from "./types.js";

/**
 * One call's document as agent-edit plans and writes on it: a room copy or a planning view, and the
 * commit options every write on it carries. The model reads it fresh after each write.
 */
export class LoroDocument {
  private blocks: ShapeBlock[] | null = null;
  private hashes: Map<BlockId, string> | null = null;
  private readonly refs = new Map<BlockId, LoroBlock>();

  constructor(
    readonly docs: RoomDocs,
    readonly schema: Schema,
    /** The author and origin of every write on this document (a chat's turn). */
    public write: WriteOptions = {},
  ) {}

  /** The document's top-level blocks as every reader sees them. */
  top(): readonly ShapeBlock[] {
    this.blocks ??= readDocument(this.docs);
    return this.blocks;
  }

  /** The display hash of each top-level block: the shortest unique prefix of its id's hash. */
  hashOf(id: BlockId): string {
    if (!this.hashes) {
      const ids = this.top().map((block) => block.id);
      const prefixes = uniqueHashPrefixes(ids.map(fullHashForBlockId));
      this.hashes = new Map(ids.map((blockId, index) => [blockId, prefixes[index]]));
    }
    const hash = this.hashes.get(id);
    if (hash === undefined) throw new Error(`Block ${id} is not in the document`);
    return hash;
  }

  /** The one ref of a block id, so a ref keeps its identity across reads. */
  ref(id: BlockId): LoroBlock {
    let ref = this.refs.get(id);
    if (!ref) {
      ref = { id, document: this };
      this.refs.set(id, ref);
    }
    return ref;
  }

  shape(id: BlockId): ShapeBlock | undefined {
    return this.top().find((block) => block.id === id);
  }

  /**
   * Apply ops and forget the read: the next reader reads what the write left. An empty paragraph
   * the ops stored under a fresh id keeps its ref, which moves to the new id, so a later edit
   * anchored on it and the result that lists it follow it.
   */
  apply(ops: readonly ShapeOp[]): ReturnType<typeof applyShapeOps> {
    const result = applyShapeOps(this.docs, ops, { ...this.write, newBlockId });
    if (result.ok)
      for (const [from, to] of result.renamed) {
        const ref = this.refs.get(from);
        if (!ref) continue;
        this.refs.delete(from);
        ref.id = to;
        this.refs.set(to, ref);
      }
    this.forget();
    return result;
  }

  /** Forget the read after the docs changed under it (an imported batch). */
  forget(): void {
    this.blocks = null;
    this.hashes = null;
  }
}

/** A top-level block of a `LoroDocument`, by id. */
export interface LoroBlock {
  /** Changes only when `LoroDocument.apply` stores this empty paragraph under a fresh id. */
  id: BlockId;
  readonly document: LoroDocument;
}

/** The block operations the resolver, apply and the renderers run on a `LoroDocument`. */
export type DocumentModel = ReturnType<typeof loroModel>;

export function loroModel(schema: Schema) {
  const nodeFor = (block: LoroBlock): PMNode => {
    const shape = block.document.shape(block.id);
    if (!shape) throw new Error(`Block ${block.id} is not in the document`);
    return nodeOf(schema, shape);
  };
  return {
    schema,

    /** All top-level blocks. */
    getBlocks: (document: LoroDocument): LoroBlock[] =>
      document.top().map((block) => document.ref(block.id)),

    /** A block's display hash. */
    getBlockId: (block: LoroBlock): string => block.document.hashOf(block.id),

    /** Every top-level block's display hash, in order. */
    getDocumentBlockIds: (document: LoroDocument): string[] =>
      document.top().map((block) => document.hashOf(block.id)),

    /** Whether the block is still in its document. */
    isLive: (block: LoroBlock): boolean => block.document.shape(block.id) !== undefined,

    getBlockType: (block: LoroBlock): string => block.document.shape(block.id)?.node ?? "",

    /** The heading level of a heading; undefined otherwise. */
    getHeadingLevel: (block: LoroBlock): number | undefined => {
      const shape = block.document.shape(block.id);
      const level = shape?.node === "paragraph" ? shape.attrs.level : undefined;
      return level == null ? undefined : Number(level);
    },

    getText: (block: LoroBlock): string => nodeFor(block).textContent,

    /** Insert blocks after `after` (null: at the start); returns the inserted blocks. */
    insertBlocks(
      document: LoroDocument,
      after: LoroBlock | null,
      parsed: ParsedContent,
    ): LoroBlock[] {
      // The codec's blocks have no ids: this is where they become stored blocks.
      const blocks = blocksOf(
        schema.topNodeType.create(
          null,
          parsed.blocks.map((block) => withBlockIds(block)),
        ),
      );
      if (blocks.length === 0) return [];
      const anchor = after ? after.id : null;
      const result = document.apply([{ kind: "insert", parent: null, after: anchor, blocks }]);
      if (!result.ok) throw new Error(result.message);
      return blocks.map((block) => document.ref(block.id));
    },

    /** Delete a block; the last block is cleared instead. */
    deleteBlock(document: LoroDocument, block: LoroBlock): void {
      const result = document.apply([{ kind: "delete", block: block.id }]);
      if (!result.ok) throw new Error(result.message);
    },

    /** Record that an edit moved text between two blocks (a split, a join); `b` may be gone. */
    recordPieces(document: LoroDocument, a: LoroBlock, b: LoroBlock): void {
      const result = document.apply([{ kind: "pieces", blocks: [a.id, b.id] }]);
      if (!result.ok) throw new Error(result.message);
    },

    /**
     * Apply operations to one top-level block, addressed on its state before any of them.
     * Every path and offset is checked before anything changes; a write that does not fit
     * the block fails and leaves it as it was. An edited block keeps its element and its id;
     * an inserted node keeps an id it already has and takes a new one otherwise.
     */
    applyOps(document: LoroDocument, block: LoroBlock, ops: readonly EditOp[]): EditOpsResult {
      const shape = document.shape(block.id);
      if (!shape) return invalid(`block ${block.id} is not in the document`);
      const lowered: ShapeOp[] = [];
      for (const op of ops) {
        const shaped = shapeOp(schema, shape, op);
        if (typeof shaped === "string")
          return invalid(`Cannot apply a ${op.kind} operation: ${shaped}`);
        lowered.push(shaped);
      }
      const result = document.apply(lowered);
      return result.ok ? { ok: true } : result;
    },

    /** The editor that typed each unit of the textblock at `path` under a top-level block. */
    unitEditors(block: LoroBlock, path: readonly number[]): EditorOf {
      const { document, id } = block;
      const shape = document.shape(id);
      const node = shape && shapeAt(shape, path);
      const rule = node?.kind === "text" ? document.docs.shape.node(node.node) : undefined;
      if (!node || !rule) return () => undefined;
      const editors = unitEditors(document.docs.textOf(node.id), rule, document.docs.shape);
      return (unit) => editors[unit];
    },

    /** Every top-level block with its display hash and node, built in one walk. */
    projectBlocks(document: LoroDocument): ProjectedBlock[] {
      return document.top().map(
        (block): ProjectedBlock => ({
          ref: document.ref(block.id),
          key: block.id,
          hash: document.hashOf(block.id),
          fullHash: fullHashForBlockId(block.id),
          // The model reads and writes Markdown, which has no ids, so its view of a block has none:
          // a block it leaves alone compares equal to its own Markdown and keeps its id.
          node: withoutBlockIds(nodeOf(schema, block)),
        }),
      );
    },
  };
}

function invalid(message: string) {
  return { ok: false as const, code: "invalid_write" as const, message };
}

/** The shape block at `path` (child indexes) under `block`, as the model's view read it. */
function shapeAt(block: ShapeBlock, path: readonly number[]): ShapeBlock | undefined {
  let node: ShapeBlock | undefined = block;
  for (const index of path) {
    if (node?.kind !== "container") return undefined;
    node = node.children[index];
  }
  return node;
}

/** One `EditOp`, addressed by path in the model's view, as a `ShapeOp` addressed by block id. */
function shapeOp(schema: Schema, block: ShapeBlock, op: EditOp): ShapeOp | string {
  const node = shapeAt(block, op.path);
  if (!node) return "its path does not address a block";
  switch (op.kind) {
    case "text":
      if (node.kind !== "text") return `${node.id} is not a textblock`;
      return {
        kind: "text",
        block: node.id,
        splices: op.splices.map(({ from, to, content }) => ({
          from,
          to,
          content: inlineOf(content),
        })),
        formats: op.formats.map(({ from, to, mark, attrs }) => ({
          from,
          to,
          mark: styleKey(mark, attrs),
          value: attrs,
        })),
      };
    case "attrs":
      return {
        kind: "attrs",
        block: node.id,
        attrs: op.attrs,
        ...(op.unit === undefined ? {} : { unit: op.unit }),
      };
    case "delete":
      if (op.path.length === 0) return "a block does not delete itself";
      return { kind: "delete", block: node.id };
    case "insert": {
      if (node.kind !== "container") return `${node.id} holds no blocks`;
      const after = op.after < 0 ? null : node.children[op.after]?.id;
      if (after === undefined) return "no child to insert after";
      return {
        kind: "insert",
        parent: node.id,
        after,
        blocks: op.nodes.map((child) => shapeBlockOf(schema, withBlockIds(child))),
      };
    }
  }
}

function shapeBlockOf(schema: Schema, node: PMNode): ShapeBlock {
  const [block] = blocksOf(schema.topNodeType.create(null, [node]));
  return block;
}

/**
 * The stored style of a lowered format's key: the mark's name, or for a mark that may overlap
 * the Loro key (`comment_<id>` for a comment).
 */
function styleKey(mark: string, attrs: Record<string, unknown> | null): string {
  if (mark === COMMENT_MARK && attrs?.id != null)
    return `${COMMENT_STYLE_PREFIX}${String(attrs.id)}`;
  return mark;
}
