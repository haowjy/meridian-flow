import type { Delta, LoroDoc, LoroText } from "loro-crdt";
import { keyBetween, orderKeys } from "./order-key.js";
import { commentVisibility, textUnits } from "./read.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type Attrs,
  type BlockId,
  INLINE_STYLE,
  type InlineItem,
  type Marks,
  type NodeRule,
  SENTINEL,
  type ShapeBlock,
  type ShapeSchema,
  storedAttrs,
  TEXT_KEY,
} from "./shape.js";
import { StructureView } from "./structure.js";
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
  /** `blocks` go under `parent` (null: the document), after its shown child `after` (null: first). */
  | { kind: "insert"; parent: BlockId | null; after: BlockId | null; blocks: readonly ShapeBlock[] }
  /** The block goes, with every block shown under it. */
  | { kind: "delete"; block: BlockId }
  /** Set (or with null clear) attributes of the block, or of its inline node at `unit`. */
  | { kind: "attrs"; block: BlockId; attrs: Attrs; unit?: number };

export type ApplyOpsResult =
  | { ok: true; changes: DocChange[] }
  | { ok: false; code: "invalid_write"; message: string };

/**
 * Apply `ops` to the docs (in a draft, as overrides and forked text docs) and commit every doc they
 * touched under `options.message`. Every op is checked against the docs before anything changes,
 * so a write that does not fit leaves them alone. Text and attributes go first, then inserts,
 * then deletes, as the Yjs `applyOps` did.
 */
export function applyOps(
  docs: RoomDocs,
  ops: readonly ShapeOp[],
  options: WriteOptions = {},
): ApplyOpsResult {
  const { shape } = docs;
  const view = new StructureView(docs.structure, docs.draft, shape);
  const visibleComment = commentVisibility(view);
  const ruleOf = (id: BlockId) =>
    view.shown.has(id) ? shape.node(view.node(id) as string) : undefined;
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
    if (op.kind === "insert") {
      if (op.parent !== null && !ruleOf(op.parent)) return `no shown block ${op.parent}`;
      if (op.parent !== null && ruleOf(op.parent)?.textblock) return "a textblock holds no blocks";
      if (op.after !== null && !view.children(op.parent).includes(op.after))
        return `${op.after} is not a shown child of ${op.parent ?? "the document"}`;
      return undefined;
    }
    const rule = ruleOf(op.block);
    if (!rule) return `no shown block ${op.block}`;
    if (op.kind === "delete") return undefined;
    if (op.kind === "attrs") {
      if (op.unit === undefined) return undefined;
      const units = rule.textblock ? shownUnits(docs.textOf(op.block), rule, shape) : [];
      return units[op.unit]?.inline ? undefined : `no inline node at unit ${op.unit}`;
    }
    if (!rule.textblock) return `${op.block} is not a textblock`;
    const size = shownUnits(docs.textOf(op.block), rule, shape).length;
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

  for (const op of of("text")) {
    const { doc, before: start } = docs.writableText(op.block);
    const rule = ruleOf(op.block) as NodeRule;
    const text = doc.getText(TEXT_KEY);
    for (const { from, to, mark, value } of op.formats) {
      const units = shownUnits(doc, rule, shape);
      const range = { start: units[from].pos, end: units[to - 1].pos + 1 };
      if (value === null || value === undefined) text.unmark(range, mark);
      else text.mark(range, mark, value as never);
    }
    // Right to left, so earlier offsets stay where they were planned.
    for (const { from, to, content } of [...op.splices].reverse()) {
      const units = shownUnits(doc, rule, shape);
      const removed = units.slice(from, to).map((unit) => unit.pos);
      for (let end = removed.length; end > 0; ) {
        let first = end - 1;
        while (first > 0 && removed[first - 1] === removed[first] - 1) first--;
        text.delete(removed[first], removed[end - 1] - removed[first] + 1);
        end = first;
      }
      const after = shownUnits(doc, rule, shape);
      const at = from < after.length ? after[from].pos : rawLength(doc);
      insertItems(text, at, content);
    }
    doc.commit({ message: options.message, origin: options.origin });
    record({ key: op.block, doc, before: start, after: doc.frontiers() });
  }

  for (const op of of("attrs")) {
    if (op.unit === undefined) {
      const merged = { ...view.attrs(op.block), ...op.attrs };
      writer.block(op.block, view.parent(op.block) ?? null, view.node(op.block) as string, merged);
      continue;
    }
    const { doc, before: start } = docs.writableText(op.block);
    const unit = shownUnits(doc, ruleOf(op.block) as NodeRule, shape)[op.unit];
    const inline = unit.inline as { node: string; attrs: Attrs };
    const attrs = storedAttrs({ ...inline.attrs, ...op.attrs });
    doc.getText(TEXT_KEY).mark({ start: unit.pos, end: unit.pos + 1 }, INLINE_STYLE, {
      type: inline.node,
      attrs,
    } as never);
    doc.commit({ message: options.message, origin: options.origin });
    record({ key: op.block, doc, before: start, after: doc.frontiers() });
  }

  const random = options.random ?? Math.random;
  for (const op of of("insert")) {
    const siblings = view.children(op.parent);
    const lower = op.after === null ? null : (view.order(op.after) as string);
    const nextId = op.after === null ? siblings[0] : siblings[siblings.indexOf(op.after) + 1];
    const upper = nextId === undefined ? null : (view.order(nextId) as string);
    let key = lower;
    for (const block of op.blocks) {
      key = keyBetween(key, upper, random);
      insertBlock(block, op.parent, key);
    }
  }
  function insertBlock(block: ShapeBlock, parent: BlockId | null, key: string) {
    writer.set("order", block.id, key);
    writer.block(block.id, parent, block.node, block.attrs);
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
    record(writeText(docs, block.id, block.inline, rule, visibleComment, options));
  }

  for (const op of of("delete")) {
    const remove = (id: BlockId) => {
      writer.remove(id);
      for (const child of view.children(id)) remove(child);
    };
    remove(op.block);
  }

  const structure = commitStructure(docs, before, options);
  return { ok: true, changes: [...(structure ? [structure] : []), ...changes.values()] };
}

/** The units a reader shows, with their raw positions in the text. */
function shownUnits(doc: LoroDoc | undefined, rule: NodeRule, shape: ShapeSchema) {
  return textUnits(doc, rule, shape).filter((unit) => !unit.hidden);
}

function rawLength(doc: LoroDoc): number {
  return doc.getText(TEXT_KEY).length;
}

/**
 * Insert `items` at raw position `at`, then clear any style the insert took from a neighbour
 * (an expanding mark at its edge) that the items do not carry.
 */
function insertItems(text: LoroText, at: number, items: readonly InlineItem[]) {
  const delta: Delta<string>[] = at > 0 ? [{ retain: at }] : [];
  const wanted: Marks[] = [];
  for (const item of items) {
    if (item.kind === "inline") {
      delta.push({
        insert: SENTINEL,
        attributes: { ...item.marks, [INLINE_STYLE]: { type: item.node, attrs: item.attrs } },
      } as Delta<string>);
      wanted.push({ ...item.marks, [INLINE_STYLE]: { type: item.node, attrs: item.attrs } });
    } else if (item.text.length > 0) {
      delta.push({ insert: item.text, attributes: { ...item.marks } } as Delta<string>);
      for (let i = 0; i < item.text.length; i++) wanted.push(item.marks);
    }
  }
  if (wanted.length === 0) return;
  text.applyDelta(delta);
  const stray = new Map<string, number[]>();
  let pos = 0;
  for (const part of text.toDelta() as Delta<string>[]) {
    const length = part.insert?.length ?? 0;
    for (let i = 0; i < length; i++, pos++) {
      if (pos < at || pos >= at + wanted.length) continue;
      for (const key of Object.keys(part.attributes ?? {}))
        if (!(key in wanted[pos - at])) stray.set(key, [...(stray.get(key) ?? []), pos]);
    }
  }
  for (const [key, positions] of stray)
    for (let i = 0; i < positions.length; ) {
      let j = i;
      while (j + 1 < positions.length && positions[j + 1] === positions[j] + 1) j++;
      text.unmark({ start: positions[i], end: positions[j] + 1 }, key);
      i = j + 1;
    }
}
