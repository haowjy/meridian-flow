/**
 * The minimal Yjs writer: writes target blocks into an XmlFragment as per-word edits so every item the
 * target leaves alone keeps its identity, and a peer's concurrent edits to those items survive.
 *
 * `correspond` says which top-level block is which, by id (equal blocks are untouched). A paired block
 * is written by the model's own lowering and adapter (`lowerBlock`, `applyOps`): operations on its
 * text, marks, attributes and, in a container, its nodes, so the element stays. Only a block that pairs
 * with nothing (a type change) is deleted and rebuilt. Never use `updateYFragment` here: its one
 * prefix/suffix diff per text retypes everything between two edits, so a peer's deletion in the middle
 * would be undone.
 */

import { assertBlockIds } from "@meridian/prosemirror-schema";
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { applyOps, pmNodeToYElement } from "../model/y-prosemirror.js";
import type { EditOp } from "../ports/model.js";
import { lowerBlock } from "../resolver/lower-block.js";
import { splitTextBoundaries } from "../yjs-mutation.js";
import { correspond } from "./correspond.js";
import { readBlocks } from "./fragments.js";
import { type RestorationLink, recordWriteBack } from "./restorations.js";
import { diffKeys, splitWords } from "./tokens.js";

/**
 * Where a write reports the text it makes again, as links from the new item to the old one.
 * `gap` (Discard) links only equal words inside a gap that had to be rebuilt. `write` (a pull) links
 * across the whole write: blocks of one id first, then the words left over, in document order, so
 * a block that was split or joined still names its words' old items.
 */
export interface WriteLinks {
  scope: "gap" | "write";
  copies: RestorationLink[];
}

export interface WriteStats {
  kept: number;
  edited: number; // written in place: operations on the existing element
  inserted: number;
  deleted: number;
}

/**
 * Writes `target` into the fragment: unchanged blocks are untouched, a block whose type and inline
 * shape allow it is edited in place, the rest are replaced. Call inside one transaction.
 */
export function writeBlocks(
  frag: Y.XmlFragment,
  schema: Schema,
  target: readonly PMNode[],
  links?: WriteLinks,
): WriteStats {
  // Every door that makes blocks gives them ids first, so one without is a bug at that door.
  for (const block of target) assertBlockIds(block);
  const stats: WriteStats = { kept: 0, edited: 0, inserted: 0, deleted: 0 };
  writeChildren(frag, readBlocks(frag, schema), target, stats, links);
  return stats;
}

/**
 * Writes `target` into the top-level blocks of `parent`, which hold `current`. A gap is
 * structural for Discard's restoration links when a block in it pairs with nothing or its
 * operations insert or delete a node (a row added to a table).
 */
function writeChildren(
  parent: Y.XmlFragment,
  current: readonly PMNode[],
  target: readonly PMNode[],
  stats: WriteStats,
  links: WriteLinks | undefined,
): void {
  // An id match is final; blocks with no id (the model's write) pair by guess. A block that moved,
  // or whose id now names another type of element, is deleted where it was and inserted where it is.
  const found = correspond(current, target, { byId: true });
  const partner = found.partner.map((t, c) =>
    t >= 0 && !found.moved.has(c) && current[c].type === target[t].type ? t : -1,
  );
  // Gaps between equal blocks, as [curFrom, curTo, tgtFrom, tgtTo].
  const gaps: Array<[number, number, number, number]> = [];
  let [ci, ti] = [0, 0];
  const close = (c1: number, t1: number) => {
    if (c1 > ci || t1 > ti) gaps.push([ci, c1, ti, t1]);
  };
  partner.forEach((t, c) => {
    if (t < 0 || !current[c].eq(target[t])) return;
    close(c, t);
    [ci, ti] = [c + 1, t + 1];
    stats.kept++;
  });
  close(current.length, target.length);
  const doc = parent.doc as Y.Doc;
  const writeClock = Y.getState(doc.store, doc.clientID);
  const gone: BlockUnits[] = [];
  const made: BlockUnits[] = [];
  // Right to left, so earlier element indexes stay valid.
  for (const [c0, c1, t0, t1] of gaps.reverse()) {
    const pairs: Array<[number, number]> = [];
    for (let c = c0; c < c1; c++) if (partner[c] >= 0) pairs.push([c, partner[c]]);
    // Operations address each block as it is now, so they are lowered before anything is written.
    const ops = new Map(pairs.map(([c, t]) => [c, lowerBlock(current[c], target[t])]));
    const rebuilt =
      links?.scope === "gap" &&
      (pairs.length !== c1 - c0 ||
        pairs.length !== t1 - t0 ||
        [...ops.values()].some((list) =>
          list.some((op) => op.kind === "insert" || op.kind === "delete"),
        ));
    // Only a structural gap needs a source map; capture it before deleting containers can
    // collect their descendants.
    const before = rebuilt ? copyUnits(parent.toArray().slice(c0, c1) as Y.XmlElement[]) : null;
    // A pull's links are made across gaps (a moved block leaves one and arrives in another).
    if (links?.scope === "write") gone.unshift(...blockUnits(parent.toArray().slice(c0, c1)));
    // Yjs splits with Array.splice. Pre-splitting in clock order keeps a full rewrite from
    // shifting all later paragraphs' new word items at each boundary; no clocks are allocated.
    const runs: Array<{ text: Y.XmlText; offsets: number[] }> = [];
    const visit = (element: Y.XmlElement) => {
      for (const child of element.toArray()) {
        if (child instanceof Y.XmlElement) visit(child);
        else if (child instanceof Y.XmlText) {
          let offset = 0;
          const value = (child.toDelta() as Array<{ insert: string }>)
            .map((part) => part.insert)
            .join("");
          const offsets = splitWords(value).map((word) => (offset += word.length));
          runs.push({ text: child, offsets });
        }
      }
    };
    for (const [c] of pairs) visit(parent.get(c) as Y.XmlElement);
    doc.transact((transaction) => splitTextBoundaries(transaction, runs));
    const clock = Y.getState(doc.store, doc.clientID);
    const pairedC = new Map(pairs);
    const pairedT = new Set(pairs.map(([, t]) => t));
    // Walk the gap backwards: delete unpaired old blocks, edit paired ones, insert new ones.
    let tPtr = t1;
    for (let c = c1 - 1; c >= c0 - 1; c--) {
      const t = c >= c0 ? pairedC.get(c) : t0 - 1;
      if (t === undefined) {
        parent.delete(c, 1);
        stats.deleted++;
        continue;
      }
      // New blocks between this paired block and the previous one written.
      const ins: PMNode[] = [];
      for (let k = t + 1; k < tPtr; k++) if (!pairedT.has(k)) ins.push(target[k]);
      if (ins.length) {
        parent.insert(c + 1, ins.map(pmNodeToYElement));
        stats.inserted += ins.length;
      }
      tPtr = t;
      if (c < c0) break;
      const applied = applyOps(parent.get(c) as Y.XmlElement, ops.get(c) as EditOp[]);
      if (!applied.ok) throw new Error(applied.message);
      stats.edited++;
    }
    if (before && links)
      links.copies.push(
        ...copiedUnits(
          before,
          copyUnits(parent.toArray().slice(c0, c0 + t1 - t0) as Y.XmlElement[]),
          doc.clientID,
          clock,
        ),
      );
    if (links?.scope === "write")
      made.unshift(...blockUnits(parent.toArray().slice(c0, c0 + t1 - t0)));
  }
  if (links?.scope === "write") links.copies.push(...linkRecreated(doc, gone, made, writeClock));
}

interface BlockUnits {
  id: unknown;
  units: CopyUnit[];
}

function blockUnits(blocks: unknown[]): BlockUnits[] {
  return (blocks as Y.XmlElement[]).map((block) => ({
    id: block.getAttribute("id"),
    units: copyUnits([block]),
  }));
}

/**
 * The words a pull's write made again, each linked to the item it replaced. Blocks that kept one
 * id pair first (a move, a rebuilt container, a run written whole). The words that deleted blocks
 * lost and new blocks gained are then matched in document order, so a block split in two or two
 * joined into one still names its words' old items. Whole equal words only.
 */
function linkRecreated(
  doc: Y.Doc,
  gone: BlockUnits[],
  made: BlockUnits[],
  clock: number,
): RestorationLink[] {
  const links: RestorationLink[] = [];
  const oldById = new Map(gone.map((block) => [block.id, block]));
  const linked = new Set<string>();
  const run = (before: CopyUnit[], after: CopyUnit[]) => {
    for (const link of copiedUnits(before, after, doc.clientID, clock)) {
      links.push(link);
      for (let n = 0; n < link[2]; n++) {
        linked.add(`${link[0]}:${link[1] + n}`);
        linked.add(`${link[3]}:${link[4] + n}`);
      }
    }
  };
  for (const block of made) {
    const old = block.id === null ? undefined : oldById.get(block.id);
    if (old) run(old.units, block.units);
  }
  // Closing markers stay on both sides: they keep the last word of one block from gluing to the first of the next.
  const dead = (unit: CopyUnit) =>
    unit.client < 0 ||
    ((Y.getItem(doc.store, Y.createID(unit.client, unit.clock)) as Y.Item).deleted &&
      !linked.has(`${unit.client}:${unit.clock}`));
  const fresh = (unit: CopyUnit) =>
    unit.client < 0 ||
    (unit.client === doc.clientID &&
      unit.clock >= clock &&
      !linked.has(`${unit.client}:${unit.clock}`));
  run(
    gone.flatMap((block) => block.units).filter(dead),
    made.flatMap((block) => block.units).filter(fresh),
  );
  links.push(...twinTombstones(doc, links));
  return links;
}

/**
 * Undo restores a deleted word with Yjs's own redo, which puts it back in the text node it was deleted
 * from. Once a split or a join has put the neighbours in another node, that is the wrong place, so the
 * tombstones between re-created words are re-created too, dead, beside their copies, and linked: the
 * restore then lands among the words that stand now. Only tombstones from before this write, next to a
 * linked word.
 */
function twinTombstones(doc: Y.Doc, links: readonly RestorationLink[]): RestorationLink[] {
  const copyOf = new Map<string, Y.ID>();
  const nodes = new Set<Y.XmlText>();
  for (const [client, clock, len, from, at] of links)
    for (let n = 0; n < len; n++) {
      copyOf.set(`${from}:${at + n}`, Y.createID(client, clock + n));
      const parent = (Y.getItem(doc.store, Y.createID(from, at + n)) as Y.Item).parent;
      if (parent instanceof Y.XmlText) nodes.add(parent);
    }
  const writeDeleted = (doc._transaction as Y.Transaction).deleteSet;
  const copyAt = (item: Y.Item | undefined, last: boolean) =>
    item?.content instanceof Y.ContentString
      ? copyOf.get(`${item.id.client}:${item.id.clock + (last ? item.length - 1 : 0)}`)
      : undefined;
  const textIndex = (id: Y.ID) => {
    const node = (Y.getItem(doc.store, id) as Y.Item).parent as Y.XmlText;
    let index = 0;
    for (let item = node._start; item; item = item.right) {
      if (
        item.id.client === id.client &&
        id.clock >= item.id.clock &&
        id.clock < item.id.clock + item.length
      )
        return { node, index: index + id.clock - item.id.clock };
      if (!item.deleted && item.countable) index += item.length;
    }
    throw new Error("A linked copy is not in its text node");
  };
  const tomb = (item: Y.Item) =>
    item.deleted && item.content instanceof Y.ContentString && !Y.isDeleted(writeDeleted, item.id);
  const twins: RestorationLink[] = [];
  for (const node of nodes) {
    const items: Y.Item[] = [];
    for (let item = node._start; item; item = item.right) items.push(item);
    for (let i = 0; i < items.length; ) {
      if (!tomb(items[i])) {
        i++;
        continue;
      }
      let end = i;
      while (end < items.length && tomb(items[end])) end++;
      const run = items.slice(i, end);
      const after = copyAt(items[i - 1], true);
      const anchor = after ?? copyAt(items[end], false);
      i = end;
      if (!anchor) continue;
      const { node: host, index } = textIndex(anchor);
      const at = index + (after ? 1 : 0);
      const text = run.map((item) => (item.content as Y.ContentString).str).join("");
      const start = Y.getState(doc.store, doc.clientID);
      host.insert(at, text);
      host.delete(at, text.length);
      let twin: Y.Item | undefined;
      for (let item = host._start; item && !twin; item = item.right)
        if (
          item.id.client === doc.clientID &&
          item.id.clock >= start &&
          item.deleted &&
          item.content instanceof Y.ContentString &&
          item.content.str === text
        )
          twin = item;
      if (!twin) throw new Error("A twin tombstone was not created");
      let offset = 0;
      for (const item of run) {
        twins.push([
          twin.id.client,
          twin.id.clock + offset,
          item.length,
          item.id.client,
          item.id.clock,
        ]);
        offset += item.length;
      }
    }
  }
  return twins;
}

interface CopyUnit {
  key: string;
  client: number;
  clock: number;
}

/** Capture live item content before a structural rewrite can collect it. One UTF-16 unit per clock. */
function copyUnits(roots: Y.XmlElement[]): CopyUnit[] {
  const out: CopyUnit[] = [];
  const add = (item: Y.Item) => {
    if (item.deleted) return;
    const { client, clock } = item.id;
    const content = item.content;
    if (content instanceof Y.ContentType) {
      const child = content.type;
      const kind = child instanceof Y.XmlElement ? child.nodeName : "text";
      out.push({ key: `type:${kind}`, client, clock });
      visit(child);
      // Closing boundaries keep equal text in distinct structural contexts aligned.
      out.push({ key: `end:${kind}`, client: -1, clock: -1 });
    } else if (content instanceof Y.ContentString) {
      for (let i = 0; i < content.str.length; i++)
        out.push({ key: `text:${content.str[i]}`, client, clock: clock + i });
    } else {
      out.push({
        key: JSON.stringify([
          item.parentSub,
          content.constructor.name,
          content instanceof Y.ContentFormat ? [content.key, content.value] : content.getContent(),
        ]),
        client,
        clock,
      });
    }
  };
  const visit = (type: Y.AbstractType<unknown>) => {
    for (const key of [...type._map.keys()].sort()) add(type._map.get(key) as Y.Item);
    for (let item = type._start; item; item = item.right) add(item);
  };
  for (const root of roots) add(root._item as Y.Item);
  return out;
}

/** Link only equal spans in a gap whose containers had to be rebuilt. */
function copiedUnits(
  before: CopyUnit[],
  after: CopyUnit[],
  client: number,
  clock: number,
): RestorationLink[] {
  // Match whole words, as the lowering's word diff does. Character matching would falsely link the shared letters
  // of a reverted word ("blue" -> "red") to the rejected AI write.
  const tokens = (units: CopyUnit[]) => {
    const out: Array<{ key: string; units: CopyUnit[] }> = [];
    for (let i = 0; i < units.length; ) {
      if (!units[i].key.startsWith("text:")) {
        out.push({ key: units[i].key, units: [units[i++]] });
        continue;
      }
      let end = i;
      let text = "";
      while (end < units.length && units[end].key.startsWith("text:"))
        text += units[end++].key.slice(5);
      for (const word of splitWords(text)) {
        out.push({ key: `text:${word}`, units: units.slice(i, i + word.length) });
        i += word.length;
      }
    }
    return out;
  };
  const left = tokens(before);
  const right = tokens(after);
  const copies: RestorationLink[] = [];
  let from = 0;
  let to = 0;
  for (const [op, length] of diffKeys(
    left.map((u) => u.key),
    right.map((u) => u.key),
  )) {
    if (op === DIFF_EQUAL) {
      for (let i = 0; i < length; i++) {
        for (let j = 0; j < left[from + i].units.length; j++) {
          const source = left[from + i].units[j];
          const copy = right[to + i].units[j];
          if (copy.client !== client || copy.clock < clock) continue;
          const last = copies.at(-1);
          if (
            last &&
            last[1] + last[2] === copy.clock &&
            last[3] === source.client &&
            last[4] + last[2] === source.clock
          )
            copies[copies.length - 1] = [last[0], last[1], last[2] + 1, last[3], last[4]];
          else copies.push([copy.client, copy.clock, 1, source.client, source.clock]);
        }
      }
    }
    if (op !== DIFF_INSERT) from += length;
    if (op !== DIFF_DELETE) to += length;
  }
  return copies;
}

/** `writeBlocks` for Discard: it also records which restored text copies which discarded text. */
export function writeDiscardBlocks(
  frag: Y.XmlFragment,
  schema: Schema,
  target: readonly PMNode[],
): void {
  const doc = frag.doc as Y.Doc;
  const clock = Y.getState(doc.store, doc.clientID);
  const copies: RestorationLink[] = [];
  writeBlocks(frag, schema, target, { scope: "gap", copies });
  recordWriteBack(doc, clock, copies);
}
