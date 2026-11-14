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

export interface WriteStats {
  kept: number;
  edited: number; // written in place: operations on the existing element
  inserted: number;
  deleted: number;
}

/**
 * Writes `target` into the fragment: unchanged blocks are untouched, a block whose type and inline
 * shape allow it is edited in place, the rest are replaced. Call inside the rebase transaction.
 */
export function writeBlocks(
  frag: Y.XmlFragment,
  schema: Schema,
  target: readonly PMNode[],
  copies?: RestorationLink[],
): WriteStats {
  // Every door that makes blocks gives them ids first, so one without is a bug at that door.
  for (const block of target) assertBlockIds(block);
  const stats: WriteStats = { kept: 0, edited: 0, inserted: 0, deleted: 0 };
  writeChildren(frag, readBlocks(frag, schema), target, stats, copies);
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
  copies: RestorationLink[] | undefined,
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
  // Right to left, so earlier element indexes stay valid.
  for (const [c0, c1, t0, t1] of gaps.reverse()) {
    const pairs: Array<[number, number]> = [];
    for (let c = c0; c < c1; c++) if (partner[c] >= 0) pairs.push([c, partner[c]]);
    // Operations address each block as it is now, so they are lowered before anything is written.
    const ops = new Map(pairs.map(([c, t]) => [c, lowerBlock(current[c], target[t])]));
    const rebuilt =
      copies !== undefined &&
      (pairs.length !== c1 - c0 ||
        pairs.length !== t1 - t0 ||
        [...ops.values()].some((list) =>
          list.some((op) => op.kind === "insert" || op.kind === "delete"),
        ));
    // Only a structural gap needs a source map; capture it before deleting containers can
    // collect their descendants.
    const before = rebuilt ? copyUnits(parent.toArray().slice(c0, c1) as Y.XmlElement[]) : null;
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
    if (before && copies)
      copies.push(
        ...copiedUnits(
          before,
          copyUnits(parent.toArray().slice(c0, c0 + t1 - t0) as Y.XmlElement[]),
          doc.clientID,
          clock,
        ),
      );
  }
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

/** Discard-only identity preservation; AI and rebase allocation policies are unchanged. */
export function writeDiscardBlocks(
  frag: Y.XmlFragment,
  schema: Schema,
  target: readonly PMNode[],
): void {
  const doc = frag.doc as Y.Doc;
  const clock = Y.getState(doc.store, doc.clientID);
  const copies: RestorationLink[] = [];
  writeBlocks(frag, schema, target, copies);
  recordWriteBack(doc, clock, copies);
}
