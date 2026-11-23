import { commitMessage } from "./commit-message.js";
import { inText } from "./handles.js";
import { keyBetween, orderKeys } from "./order-key.js";
import { retirePieces } from "./pieces.js";
import { commentVisibility, derivedEmptyParent, shownUnits } from "./read.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type Attrs,
  type BlockId,
  INLINE_STYLE,
  type InlineItem,
  type NodeRule,
  type ShapeBlock,
  storedAttrs,
} from "./shape.js";
import { StructureView } from "./structure.js";
import { replaceText } from "./text.js";
import {
  commitStructure,
  type DocChange,
  StructureWriter,
  type WriteOptions,
  writeText,
} from "./write.js";

/**
 * agent-edit's lowered edits on the shape (design §1, "Codec"; §5). Units are the textblock's
 * shown units as the model's view read them: a UTF-16 code unit of text, or one inline node.
 * Blocks are addressed by id, which agent-edit resolves from the paths and hashes it plans with.
 */
export type ShapeOp =
  | {
      kind: "text";
      block: BlockId;
      /** Ordered, non-overlapping ranges of the block as planned; each replaced by `content`. */
      splices: readonly { from: number; to: number; content: readonly InlineItem[] }[];
      /** A style key (`strong`, `comment_<id>`) set to `value`, or cleared with null. */
      formats: readonly { from: number; to: number; mark: string; value: unknown }[];
    }
  /**
   * `blocks` go under `parent` (null: the document), after its shown child `after` (null: first).
   * Inserts after the same anchor land in op order, each after the previous one's blocks.
   */
  | { kind: "insert"; parent: BlockId | null; after: BlockId | null; blocks: readonly ShapeBlock[] }
  /** The block goes, with every block shown under it. */
  | { kind: "delete"; block: BlockId }
  /** Set (or with null clear) attributes of the block, or of its inline node at `unit`. */
  | { kind: "attrs"; block: BlockId; attrs: Attrs; unit?: number }
  /**
   * The edit moved text between these two blocks (it split one, joined one into the other, or
   * carried words across their boundary): a draft records them as one change (design §2), unless
   * neither shows a change once the op is written. Either may be a block the edit removed.
   */
  | { kind: "pieces"; blocks: readonly [BlockId, BlockId] };

export interface ApplyOpsOptions extends WriteOptions {
  /** A fresh block id, for the empty paragraph a text or attribute op is the first write into. */
  newBlockId: () => BlockId;
}

export type ApplyOpsResult =
  | {
      ok: true;
      changes: DocChange[];
      /** Each empty paragraph the ops wrote into, with the fresh id it is now stored under. */
      renamed: ReadonlyMap<BlockId, BlockId>;
    }
  | { ok: false; code: "invalid_write"; message: string };

/**
 * Apply `ops` to the docs (in a draft, as overrides and forked text docs) and commit every doc they
 * touched under a commit by `options.by`. Every op is checked against the docs before anything changes,
 * so a write that does not fit leaves them alone. Text and attributes go first, then inserts,
 * then deletes.
 *
 * The unstored empty paragraph a reader sees in an empty document or cell (`derivedEmptyParent`)
 * is addressable like any block: a text or attribute op stores a paragraph in its place under a
 * fresh id (`options.newBlockId`), and every later op of the call addressing it writes that one;
 * an insert after it goes first, or after the stored paragraph; deleting it writes nothing. The
 * result's `renamed` maps each placeholder written into to its fresh id: a caller that goes on
 * addressing the paragraph (a later call, a result that lists it) must follow it there.
 */
export function applyOps(
  docs: RoomDocs,
  ops: readonly ShapeOp[],
  options: ApplyOpsOptions,
): ApplyOpsResult {
  const { shape } = docs;
  const view = new StructureView(docs);
  const visibleComment = commentVisibility(view);
  const derived = (id: BlockId | null) =>
    id === null ? undefined : derivedEmptyParent(view, shape, id);
  const ruleOf = (id: BlockId) =>
    view.shown.has(id)
      ? shape.node(view.node(id) as string)
      : derived(id) !== undefined
        ? shape.node("paragraph")
        : undefined;
  const textOf = (id: BlockId) => (view.shown.has(id) ? docs.textOf(id) : undefined);
  for (const op of ops) {
    const problem = check(op);
    if (problem)
      return {
        ok: false,
        code: "invalid_write",
        message: `Cannot apply a ${op.kind} operation: ${problem}`,
      };
  }
  function check(op: ShapeOp): string | undefined {
    if (op.kind === "pieces") return undefined;
    if (op.kind === "insert") {
      if (op.parent !== null && !ruleOf(op.parent)) return `no shown block ${op.parent}`;
      if (op.parent !== null && ruleOf(op.parent)?.textblock) return "a textblock holds no blocks";
      if (
        op.after !== null &&
        !view.children(op.parent).includes(op.after) &&
        derived(op.after) !== op.parent
      )
        return `${op.after} is not a shown child of ${op.parent ?? "the document"}`;
      return undefined;
    }
    const rule = ruleOf(op.block);
    if (!rule) return `no shown block ${op.block}`;
    if (op.kind === "delete") return undefined;
    if (op.kind === "attrs") {
      if (op.unit === undefined) return undefined;
      const units = rule.textblock ? shownUnits(textOf(op.block), rule, shape) : [];
      return units[op.unit]?.inline ? undefined : `no inline node at unit ${op.unit}`;
    }
    if (!rule.textblock) return `${op.block} is not a textblock`;
    const size = shownUnits(textOf(op.block), rule, shape).length;
    let cursor = 0;
    for (const { from, to } of op.splices) {
      if (from < cursor || to < from || to > size)
        return `invalid splice ${from}..${to} of ${size}`;
      cursor = to;
    }
    for (const { from, to } of op.formats)
      if (from < 0 || to <= from || to > size)
        return `invalid format range ${from}..${to} of ${size}`;
    return undefined;
  }

  const before = docs.structure.frontiers();
  const writer = new StructureWriter(docs, view);
  const changes = new Map<BlockId, DocChange>();
  const record = (change: DocChange | null) => {
    if (!change) return;
    const earlier = changes.get(change.key);
    changes.set(change.key, earlier ? { ...change, before: earlier.before } : change);
  };
  const of = <K extends ShapeOp["kind"]>(kind: K) =>
    ops.filter((op): op is Extract<ShapeOp, { kind: K }> => op.kind === kind);

  const random = options.random ?? Math.random;
  /** Order keys this call gave, so a later op places after a block an earlier one stored. */
  const placed = new Map<BlockId, string>();
  /** The fresh id each empty paragraph this call wrote into is stored under. */
  const stored = new Map<BlockId, BlockId>();
  /** The block an op on `id` writes: `id`, or the paragraph stored in place of its empty one. */
  const store = (id: BlockId): BlockId => {
    const parent = derived(id);
    if (parent === undefined) return id;
    let fresh = stored.get(id);
    if (fresh === undefined) {
      fresh = options.newBlockId();
      stored.set(id, fresh);
      const key = keyBetween(null, null, random);
      placed.set(fresh, key);
      writer.set("order", fresh, key);
      writer.block(fresh, parent, "paragraph", {});
    }
    return fresh;
  };

  for (const op of of("text")) {
    const rules = { rule: ruleOf(op.block) as NodeRule, shape, visibleComment };
    const block = store(op.block);
    const { doc, before: start } = docs.writableText(block);
    for (const { from, to, mark, value } of op.formats) {
      const units = shownUnits(doc, rules.rule, shape);
      const range = { start: units[from].pos, end: units[to - 1].pos + 1 };
      inText(doc, (text) => {
        if (value === null || value === undefined) text.unmark(range, mark);
        else text.mark(range, mark, value as never);
      });
    }
    // Right to left, so earlier offsets stay where they were planned.
    for (const { from, to, content } of [...op.splices].reverse())
      replaceText(doc, rules, from, to, content);
    doc.commit({ message: commitMessage({ by: options.by }), origin: options.origin });
    record({ key: block, doc, before: start, after: doc.frontiers() });
  }

  for (const op of of("attrs")) {
    if (op.unit === undefined) {
      const block = store(op.block);
      const merged = { ...view.attrs(op.block), ...op.attrs };
      const parent = view.shown.has(op.block) ? (view.parent(op.block) ?? null) : derived(op.block);
      writer.block(block, parent ?? null, view.node(op.block) ?? "paragraph", merged);
      continue;
    }
    const { doc, before: start } = docs.writableText(op.block);
    const unit = shownUnits(doc, ruleOf(op.block) as NodeRule, shape)[op.unit];
    const inline = unit.inline as { node: string; attrs: Attrs };
    const attrs = storedAttrs({ ...inline.attrs, ...op.attrs });
    inText(doc, (text) =>
      text.mark({ start: unit.pos, end: unit.pos + 1 }, INLINE_STYLE, {
        type: inline.node,
        attrs,
      } as never),
    );
    doc.commit({ message: commitMessage({ by: options.by }), origin: options.origin });
    record({ key: op.block, doc, before: start, after: doc.frontiers() });
  }

  /** The last block inserted after each anchor (`parent`, `after`), for chaining. */
  const chained = new Map<string, BlockId>();
  for (const op of of("insert")) {
    const anchor =
      op.after !== null && derived(op.after) === op.parent
        ? (stored.get(op.after) ?? null)
        : op.after;
    const siblings = view.children(op.parent);
    const nextId = anchor === null ? siblings[0] : siblings[siblings.indexOf(anchor) + 1];
    const upper = nextId === undefined ? null : (view.order(nextId) as string);
    const chain = `${op.parent ?? ""}\u0000${anchor ?? ""}`;
    const last = chained.get(chain) ?? anchor;
    let key = last === null ? null : (placed.get(last) ?? (view.order(last) as string));
    for (const block of op.blocks) {
      key = keyBetween(key, upper, random);
      placed.set(block.id, key);
      insertBlock(block, op.parent, key);
    }
    const end = op.blocks.at(-1);
    if (end) chained.set(chain, end.id);
  }
  function insertBlock(block: ShapeBlock, parent: BlockId | null, key: string) {
    writer.set("order", block.id, key);
    writer.block(block.id, parent, block.node, block.attrs, true);
    if (block.kind === "container") {
      const keys = orderKeys(
        block.children.map((child) => child.id),
        new Map(),
        random,
      );
      for (const child of block.children)
        insertBlock(child, block.id, keys.get(child.id) as string);
      return;
    }
    const rule = shape.node(block.node);
    if (!rule) throw new Error(`unknown node ${block.node}`);
    record(writeText(docs, block.id, block.inline, { rule, shape, visibleComment }, options));
  }

  for (const op of of("delete")) if (view.shown.has(op.block)) writer.remove(op.block);
  for (const op of of("pieces")) writer.pieces(...op.blocks);
  if (docs.draft)
    retirePieces(docs, [...writer.touched, ...changes.keys()], undefined, writer.recorded);

  const structure = commitStructure(docs, before, options);
  return {
    ok: true,
    changes: [...(structure ? [structure] : []), ...changes.values()],
    renamed: stored,
  };
}
