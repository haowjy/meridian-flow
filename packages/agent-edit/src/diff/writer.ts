/**
 * The minimal Yjs writer: writes target blocks into an XmlFragment as per-word edits so every item the
 * target leaves alone keeps its identity, and a peer's concurrent edits to those items survive.
 *
 * Blocks are matched by key (equal blocks are untouched); a changed block pairs with the most similar
 * target block in its gap and is edited in place when both are flat paragraph-like text. Text is diffed
 * by word and written as inserts and deletes (insert first, as `applyTextEdit` does), marks by `format`,
 * attributes by set or remove. Only a type change or non-flat content rebuilds the element. Never use
 * `updateYFragment` here: its one prefix/suffix diff per text retypes everything between two edits, so a
 * peer's deletion in the middle would be undone.
 */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { readBlocks } from "./fragments.js";
import { blockKey, diffKeys, similarity, wordDiff } from "./tokens.js";

type Attrs = Record<string, unknown>;

/** The writer wants the exact diff, however long it takes; review latency does not depend on it. */
const UNBOUNDED = { checkLines: false, timeout: 0 };

/** y-prosemirror's mark encoding: one attribute per mark, holding the mark's attrs. */
const markAttrs = (n: PMNode): Attrs =>
  Object.fromEntries(n.marks.map((m) => [m.type.name, m.attrs]));

/** Builds the Yjs element for a node, in the shape y-prosemirror reads back. */
export function pmToY(node: PMNode): Y.XmlElement {
  const el = new Y.XmlElement(node.type.name);
  for (const [k, v] of Object.entries(node.attrs))
    if (v !== null && v !== undefined) el.setAttribute(k, v as string);
  const children: Array<Y.XmlElement | Y.XmlText> = [];
  let text: Y.XmlText | null = null;
  let at = 0;
  node.forEach((child) => {
    if (child.isText) {
      if (!text) {
        text = new Y.XmlText();
        children.push(text);
        at = 0;
      }
      text.insert(at, child.text ?? "", markAttrs(child));
      at += child.text?.length ?? 0;
    } else {
      text = null;
      children.push(pmToY(child));
    }
  });
  if (children.length) el.insert(0, children);
  return el;
}

export interface WriteStats {
  kept: number;
  edited: number; // written in place: text/attr edits on the existing element
  replaced: number; // element deleted and rebuilt (type change, non-flat content)
  inserted: number;
  deleted: number;
}

const flat = (b: PMNode) => b.isTextblock && b.content.size === b.textContent.length;

/** Edits one flat Y.XmlText into the target block's text and marks, touching only what changed. */
function editText(el: Y.XmlElement, target: PMNode) {
  let xt = el.length ? (el.get(0) as Y.XmlText) : null;
  if (!xt) {
    xt = new Y.XmlText();
    el.insert(0, [xt]);
  }
  const text = xt;
  const cur = (text.toDelta() as Array<{ insert: string }>).map((d) => d.insert).join("");
  const segs: Array<{ from: number; to: number; attrs: Attrs }> = [];
  let off = 0;
  target.forEach((n) => {
    const len = n.text?.length ?? 0;
    segs.push({ from: off, to: off + len, attrs: markAttrs(n) });
    off += len;
  });
  const want = target.textContent;
  const insertRange = (at: number, tFrom: number, tTo: number) => {
    for (const s of segs) {
      const a = Math.max(s.from, tFrom);
      const b = Math.min(s.to, tTo);
      if (a < b) {
        text.insert(at, want.slice(a, b), s.attrs);
        at += b - a;
      }
    }
  };
  const ops = wordDiff(cur, want);
  let idx = 0;
  let tOff = 0;
  for (let k = 0; k < ops.length; k++) {
    const [op, s] = ops[k];
    if (op === DIFF_EQUAL) {
      idx += s.length;
      tOff += s.length;
    } else if (op === DIFF_DELETE) {
      const next = ops[k + 1];
      if (next && next[0] === DIFF_INSERT) {
        // Insert before deleting: an insert into a deleted run anchors beside writer text typed at
        // its end and can land in front of it.
        insertRange(idx, tOff, tOff + next[1].length);
        idx += next[1].length;
        tOff += next[1].length;
        k++;
      }
      text.delete(idx, s.length);
    } else {
      insertRange(idx, tOff, tOff + s.length);
      idx += s.length;
      tOff += s.length;
    }
  }
  // Marks on text that stayed.
  const delta = text.toDelta() as Array<{ insert: string; attributes?: Attrs }>;
  let p = 0;
  const curSegs = delta.map((d) => {
    const r = { from: p, to: p + d.insert.length, attrs: d.attributes ?? {} };
    p = r.to;
    return r;
  });
  for (const s of segs)
    for (const c of curSegs) {
      const a = Math.max(s.from, c.from);
      const b = Math.min(s.to, c.to);
      if (a >= b) continue;
      const diff: Attrs = {};
      for (const k of new Set([...Object.keys(s.attrs), ...Object.keys(c.attrs)]))
        if (JSON.stringify(s.attrs[k] ?? null) !== JSON.stringify(c.attrs[k] ?? null))
          diff[k] = s.attrs[k] ?? null;
      if (Object.keys(diff).length) text.format(a, b - a, diff);
    }
}

function editAttrs(el: Y.XmlElement, target: PMNode) {
  const have = el.getAttributes() as Attrs;
  for (const [k, v] of Object.entries(target.attrs)) {
    if (v === null || v === undefined) {
      if (k in have) el.removeAttribute(k);
    } else if (JSON.stringify(have[k]) !== JSON.stringify(v)) el.setAttribute(k, v as string);
  }
}

/**
 * Writes `target` into the fragment: unchanged blocks are untouched, a block whose type and inline
 * shape allow it is edited in place, the rest are replaced. Call inside the rebase transaction.
 */
export function writeBlocks(
  frag: Y.XmlFragment,
  schema: Schema,
  target: readonly PMNode[],
): WriteStats {
  const stats: WriteStats = { kept: 0, edited: 0, replaced: 0, inserted: 0, deleted: 0 };
  const current = readBlocks(frag, schema);
  // Gaps between equal blocks, as [curFrom, curTo, tgtFrom, tgtTo].
  const gaps: Array<[number, number, number, number]> = [];
  let ci = 0;
  let ti = 0;
  let g: [number, number, number, number] | null = null;
  for (const [op, n] of diffKeys(current.map(blockKey), target.map(blockKey), UNBOUNDED)) {
    if (op === DIFF_EQUAL) {
      if (g) gaps.push(g);
      g = null;
      ci += n;
      ti += n;
      stats.kept += n;
    } else {
      g ??= [ci, ci, ti, ti];
      if (op === DIFF_DELETE) g[1] = ci += n;
      else g[3] = ti += n;
    }
  }
  if (g) gaps.push(g);
  // Right to left, so earlier element indexes stay valid.
  for (const [c0, c1, t0, t1] of gaps.reverse()) {
    // Pair old and new blocks in order by similarity: an edited paragraph is written in place.
    const pairs: Array<[number, number]> = [];
    let from = c0;
    for (let t = t0; t < t1; t++) {
      let best = -1;
      let bestSim = 0.3;
      for (let c = from; c < c1; c++) {
        const sim =
          current[c].type === target[t].type ? similarity(current[c], target[t], true) : 0;
        if (
          sim > bestSim ||
          (current[c].textContent === "" &&
            target[t].type === current[c].type &&
            best < 0 &&
            c1 - c0 === t1 - t0)
        ) {
          bestSim = Math.max(sim, bestSim);
          best = c;
        }
      }
      if (best >= 0) {
        pairs.push([best, t]);
        from = best + 1;
      }
    }
    const pairedC = new Map(pairs);
    const pairedT = new Set(pairs.map(([, t]) => t));
    // Walk the gap backwards: delete unpaired old blocks, edit paired ones, insert new ones.
    let tPtr = t1;
    for (let c = c1 - 1; c >= c0 - 1; c--) {
      const t = c >= c0 ? pairedC.get(c) : t0 - 1;
      if (t === undefined) {
        frag.delete(c, 1);
        stats.deleted++;
        continue;
      }
      // New blocks between this paired block and the previous one written.
      const ins: PMNode[] = [];
      for (let k = t + 1; k < tPtr; k++) if (!pairedT.has(k)) ins.push(target[k]);
      if (ins.length) {
        frag.insert(c + 1, ins.map(pmToY));
        stats.inserted += ins.length;
      }
      tPtr = t;
      if (c < c0) break;
      const el = frag.get(c) as Y.XmlElement;
      const tgt = target[t];
      if (el.nodeName === tgt.type.name && flat(tgt) && flat(current[c]) && el.length <= 1) {
        editAttrs(el, tgt);
        editText(el, tgt);
        stats.edited++;
      } else {
        frag.delete(c, 1);
        frag.insert(c, [pmToY(tgt)]);
        stats.replaced++;
      }
    }
  }
  return stats;
}
