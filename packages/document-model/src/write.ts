import type { Frontiers, LoroDoc } from "loro-crdt";
import { type CommitAuthor, commitMessage } from "./commit-message.js";
import { commonEnds } from "./common-ends.js";
import { encodeEnvelope } from "./envelope.js";
import { inMap, inText } from "./handles.js";
import { orderKeys, type Random } from "./order-key.js";
import {
  commentVisibility,
  emptyParagraphOf,
  normalizeInline,
  readInline,
  shownUnits,
  storedOf,
  structureValues,
} from "./read.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type BlockId,
  type CommentBody,
  type DocKey,
  type InlineItem,
  overrideMap,
  pieceKey,
  type ShapeBlock,
  STRUCTURE_KEY,
  type StructureMap,
  sameValue,
  storedAttrs,
} from "./shape.js";
import { encodeRemoval, isOrderKey, StructureView } from "./structure.js";
import { patchStyles, replaceUnits, type TextRules, wantedUnits } from "./text.js";
import { type DocVersion, plainVersion } from "./version.js";

export interface DocChange {
  key: DocKey;
  doc: LoroDoc;
  before: Frontiers;
  after: Frontiers;
}

export function encodeChanges(changes: readonly DocChange[]): Uint8Array {
  const entries = new Map<DocKey, Uint8Array>();
  for (const change of changes)
    if (!entries.has(change.key)) entries.set(change.key, changeUpdate(change.doc, change.before));
  return encodeEnvelope(entries);
}

function changeUpdate(doc: LoroDoc, before: Frontiers): Uint8Array {
  if (before.length === 0) return doc.export({ mode: "update" });
  const from = doc.frontiersToVV(before);
  try {
    return doc.export({ mode: "update", from });
  } finally {
    from.free();
  }
}

export interface WriteOptions {
  by?: CommitAuthor;
  origin?: string;
  random?: Random;
  previous?: readonly ShapeBlock[];
  kept?: ReadonlySet<BlockId>;
  view?: StructureView;
  pieces?: readonly (readonly [BlockId, BlockId])[];
}

export class StructureWriter {
  constructor(
    readonly docs: RoomDocs,
    readonly view: StructureView,
  ) {}

  set(name: StructureMap, key: string, value: unknown): void {
    const { structure, draft } = this.docs;
    const base = this.view.baseValue(name, key);
    if (!draft) {
      if (!sameValue(base, value)) inMap(structure, name, (map) => map.set(key, value as never));
      return;
    }
    const override = this.view.override(name, key);
    const baseRead = name === "attrs" ? (base ?? null) : base;
    if (sameValue(baseRead, value)) {
      if (override !== undefined) inMap(structure, overrideMap(name), (map) => map.delete(key));
    } else if (!sameValue(override, value))
      inMap(structure, overrideMap(name), (map) => map.set(key, value as never));
  }

  remove(
    id: BlockId,
    at = this.view.order(id) as string,
    saw?: (key: DocKey) => DocVersion | undefined,
  ): void {
    const seen = new Map<DocKey, DocVersion>();
    for (const key of this.view.textKeysUnder(id)) {
      const doc = this.docs.textOf(key);
      // The version the copy shows, not its oplog's: a view checked out at a read (`RoomDocs.at`)
      // holds ops it never showed.
      const read = saw?.(key) ?? (doc && plainVersion(doc.version()));
      if (read) seen.set(key, read);
    }
    this.set("order", id, encodeRemoval({ at, seen }));
  }

  pieces(a: BlockId, b: BlockId): void {
    if (this.docs.draft && a !== b) this.set("pieces", pieceKey(a, b), true);
  }

  block(
    id: BlockId,
    parent: BlockId | null,
    node: string,
    attrs: Readonly<Record<string, unknown>>,
    moved = false,
  ) {
    if (moved || !this.brokenCycle(id, parent)) this.set("parent", id, parent);
    this.set("node", id, node);
    const stored = storedAttrs(attrs);
    for (const name of new Set([...Object.keys(this.view.attrs(id)), ...Object.keys(stored)]))
      this.set("attrs", `${id}/${name}`, stored[name] ?? null);
  }

  brokenCycle(id: BlockId, parent: BlockId | null): boolean {
    const read = this.view.parent(id);
    return read === parent && read !== this.view.value("parent", id);
  }

  /**
   * In a draft, delete the `d.order` of a block whose override puts it in the same place among its
   * siblings as Live's key would (dragged away and back), and every `d.comments` equal to Live's.
   * Run before the write's removals, as the gate's model does: a sibling the write removes still
   * counts, so a Discard of that removal leaves the block where the draft moved it. One drop can
   * make a sibling's override match too (two blocks dragged back past each other), so each drop is
   * judged against the order the drops before it left.
   */
  dropMatchingOverrides(ids: Iterable<BlockId>) {
    if (!this.docs.draft) return;
    const { structure } = this.docs;
    const left = new Set(ids);
    inMap(structure, overrideMap("order"), (orders) => {
      for (;;) {
        const now = new StructureView(this.docs, this.view.kept);
        const id = [...left].find((candidate) => sameOrderAsBase(now, candidate));
        if (id === undefined) break;
        orders.delete(id);
        left.delete(id);
      }
    });
    const after = new StructureView(this.docs, this.view.kept);
    inMap(structure, overrideMap("comments"), (comments) => {
      for (const key of after.overrideKeys("comments"))
        if (sameValue(after.baseValue("comments", key), after.override("comments", key)))
          comments.delete(key);
    });
  }
}

function movedAmong(read: readonly BlockId[], written: readonly BlockId[], id: BlockId): boolean {
  const inRead = new Set(read);
  const inWritten = new Set(written);
  const before = (list: readonly BlockId[], keep: Set<BlockId>) =>
    new Set(list.slice(0, list.indexOf(id)).filter((other) => keep.has(other)));
  const was = before(read, inWritten);
  const now = before(written, inRead);
  return was.size !== now.size || [...was].some((other) => !now.has(other));
}

function sameOrderAsBase(view: StructureView, id: BlockId): boolean {
  const override = view.override("order", id);
  const base = view.baseValue("order", id);
  if (!isOrderKey(override) || !isOrderKey(base)) return false;
  if (view.baseValue("parent", id) !== view.value("parent", id)) return false;
  const parent = view.parent(id) ?? null;
  for (const other of view.children(parent)) {
    if (other === id) continue;
    const key = view.order(other) as string;
    const side = (mine: string) => (mine < key ? -1 : mine > key ? 1 : id < other ? -1 : 1);
    if (side(override) !== side(base)) return false;
  }
  return true;
}

export function setCommentBody(
  docs: RoomDocs,
  comment: string,
  body: CommentBody | null,
  options: WriteOptions = {},
) {
  const view = new StructureView(docs);
  const before = docs.structure.frontiers();
  const writer = new StructureWriter(docs, view);
  if (body === null && !docs.draft) inMap(docs.structure, "comments", (map) => map.delete(comment));
  else writer.set("comments", comment, body);
  return commitStructure(docs, before, options);
}

export function writeDocument(
  docs: RoomDocs,
  blocks: readonly ShapeBlock[],
  options: WriteOptions = {},
): DocChange[] {
  const { shape } = docs;
  const known = options.previous && indexOf(options.previous);
  let view = options.view;
  let writer: StructureWriter | undefined;
  const read = () => {
    view ??= new StructureView(docs, options.kept);
    return view;
  };
  const structure = () => {
    writer ??= new StructureWriter(docs, read());
    return writer;
  };
  const before = docs.structure.frontiers();
  const random = options.random ?? Math.random;
  const visibleComment = commentVisibility(known ? structureValues(docs) : read());
  const changes: DocChange[] = [];
  const written = new Set<BlockId>();
  const take = (id: BlockId) => {
    if (written.has(id)) throw new Error(`block id ${id} appears twice`);
    written.add(id);
  };
  const keep = (block: ShapeBlock) => {
    take(block.id);
    if (block.kind === "container") for (const child of block.children) keep(child);
  };

  const walk = (list: readonly ShapeBlock[], parent: BlockId | null) => {
    const stored = storedOf(list, parent);
    const ids = stored.map((block) => block.id);
    const reordered = !sameIds(
      known ? (known.children.get(parent) ?? []) : read().children(parent),
      ids,
    );
    if (reordered) {
      const current = new Map(
        stored.map((block) => {
          const order = read().parent(block.id) === parent ? read().order(block.id) : undefined;
          return [block.id, typeof order === "string" ? order : undefined] as const;
        }),
      );
      for (const [id, key] of orderKeys(ids, current, random, read().kept))
        if (key !== current.get(id)) structure().set("order", id, key);
    }
    for (const block of stored) {
      const moved =
        reordered &&
        structure().brokenCycle(block.id, parent) &&
        movedAmong(read().children(parent), ids, block.id);
      const was = known?.blocks.get(block.id);
      const inPlace = !moved && was !== undefined && was.parent === parent;
      if (inPlace && was.block === block) {
        keep(block);
        continue;
      }
      take(block.id);
      // Only a row stored before the placeholder rule may hold one (design §1); a new one is a
      // caller that skipped giving the paragraph a fresh id.
      if (emptyParagraphOf(block.id) !== undefined && read().node(block.id) === undefined)
        throw new Error(`block id ${block.id} is a placeholder, never stored`);
      if (!inPlace || was.block.node !== block.node || !sameValue(was.block.attrs, block.attrs))
        structure().block(block.id, parent, block.node, block.attrs, moved);
      if (block.kind === "container") walk(block.children, block.id);
      else {
        const rule = shape.node(block.node);
        if (!rule) throw new Error(`unknown node ${block.node}`);
        const change = writeText(
          docs,
          block.id,
          block.inline,
          { rule, shape, visibleComment },
          options,
        );
        if (change) changes.push(change);
      }
    }
  };
  walk(blocks, null);
  const left = !known || [...known.blocks.keys()].some((id) => !written.has(id));
  if (docs.draft || writer || left) structure().dropMatchingOverrides(written);
  if (left)
    for (const id of read().shown) {
      const parent = read().parent(id);
      const goesWithParent = typeof parent === "string" && !written.has(parent);
      if (!written.has(id) && !goesWithParent) structure().remove(id);
    }
  if (docs.draft) for (const [a, b] of options.pieces ?? []) structure().pieces(a, b);
  const committed = commitStructure(docs, before, options);
  if (committed) changes.unshift(committed);
  return changes;
}

function indexOf(previous: readonly ShapeBlock[]) {
  const blocks = new Map<BlockId, { block: ShapeBlock; parent: BlockId | null }>();
  const children = new Map<BlockId | null, BlockId[]>();
  const walk = (list: readonly ShapeBlock[], parent: BlockId | null) => {
    const stored = storedOf(list, parent);
    for (const block of stored) {
      blocks.set(block.id, { block, parent });
      if (block.kind === "container") walk(block.children, block.id);
    }
    children.set(
      parent,
      stored.map((block) => block.id),
    );
  };
  walk(previous, null);
  return { blocks, children };
}

const sameIds = (a: readonly BlockId[], b: readonly BlockId[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export function commitStructure(
  docs: RoomDocs,
  before: Frontiers,
  options: WriteOptions,
): DocChange | null {
  docs.structure.commit({ message: commitMessage(options.by), origin: options.origin });
  const after = docs.structure.frontiers();
  return sameValue(before, after)
    ? null
    : { key: STRUCTURE_KEY, doc: docs.structure, before, after };
}

export function writeText(
  docs: RoomDocs,
  id: BlockId,
  inline: readonly InlineItem[],
  rules: TextRules,
  options: WriteOptions,
): DocChange | null {
  const wantedItems = normalizeInline(inline);
  const current = readInline(docs.textOf(id), rules.rule, rules.shape, rules.visibleComment);
  if (sameValue(current, wantedItems)) return null;
  const { doc, before } = docs.writableText(id);
  const target = wantedUnits(wantedItems);
  const shown = shownUnits(doc, rules.rule, rules.shape);
  const splice = spliceOf(
    shown.map((unit) => unit.ch).join(""),
    target.map((unit) => unit.ch).join(""),
  );
  replaceUnits(
    doc,
    rules,
    splice.index,
    splice.index + splice.remove,
    target.slice(splice.index, splice.index + splice.insert),
  );
  inText(doc, (text) => patchStyles(text, shownUnits(doc, rules.rule, rules.shape), target, rules));
  doc.commit({ message: commitMessage(options.by), origin: options.origin });
  const after = doc.frontiers();
  return sameValue(before, after) ? null : { key: id, doc, before, after };
}

function spliceOf(a: string, b: string): { index: number; remove: number; insert: number } {
  let { start, end } = commonEnds(a, b);
  if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(a.charCodeAt(a.length - end)) && a.length - end > start) end--;
  return { index: start, remove: a.length - end - start, insert: b.length - end - start };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
