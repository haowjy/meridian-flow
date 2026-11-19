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
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { applyOps, pmNodeToYElement } from "../model/y-prosemirror.js";
import type { EditOp } from "../ports/model.js";
import { lowerBlock } from "../resolver/lower-block.js";
import { splitTextBoundaries } from "../yjs-mutation.js";
import { correspond } from "./correspond.js";
import { readBlocks } from "./fragments.js";
import { splitWords } from "./tokens.js";

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
): WriteStats {
  // Every door that makes blocks gives them ids first, so one without is a bug at that door.
  for (const block of target) assertBlockIds(block);
  const stats: WriteStats = { kept: 0, edited: 0, inserted: 0, deleted: 0 };
  writeChildren(frag, readBlocks(frag, schema), target, stats);
  return stats;
}

/**
 * Writes `target` into the top-level blocks of `parent`, which hold `current`.
 */
function writeChildren(
  parent: Y.XmlFragment,
  current: readonly PMNode[],
  target: readonly PMNode[],
  stats: WriteStats,
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
  }
}
