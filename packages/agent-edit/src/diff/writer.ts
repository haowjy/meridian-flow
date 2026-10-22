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
import { splitTextBoundaries } from "../yjs-mutation.js";
import { readBlocks } from "./fragments.js";
import { type RestorationLink, recordWriteBack } from "./restorations.js";
import { blockKey, diffKeys, similarity, splitWords, wordDiff } from "./tokens.js";

type Attrs = Record<string, unknown>;

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
function editText(text: Y.XmlText, target: readonly PMNode[]) {
  const cur = (text.toDelta() as Array<{ insert: string }>).map((d) => d.insert).join("");
  const segs: Array<{ from: number; to: number; attrs: Attrs }> = [];
  let off = 0;
  target.forEach((n) => {
    const len = n.text?.length ?? 0;
    segs.push({ from: off, to: off + len, attrs: markAttrs(n) });
    off += len;
  });
  const want = target.map((n) => n.textContent).join("");
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
  copies?: RestorationLink[],
): WriteStats {
  const preserve = copies !== undefined;
  const stats: WriteStats = { kept: 0, edited: 0, replaced: 0, inserted: 0, deleted: 0 };
  const current = readBlocks(frag, schema);
  // Gaps between equal blocks, as [curFrom, curTo, tgtFrom, tgtTo].
  const gaps: Array<[number, number, number, number]> = [];
  let ci = 0;
  let ti = 0;
  let g: [number, number, number, number] | null = null;
  for (const [op, n] of diffKeys(current.map(blockKey), target.map(blockKey))) {
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
      // A lone flat rewrite has no competing alignment: retain its container even when
      // no words survived, so a late key still has a live parent.
      const oneToOneFlat =
        c1 - c0 === 1 &&
        t1 - t0 === 1 &&
        current[c0].type === target[t].type &&
        flat(current[c0]) &&
        flat(target[t]);
      let bestSim = preserve || oneToOneFlat ? -1 : 0.3;
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
    const rebuilt =
      preserve &&
      (pairs.length !== c1 - c0 ||
        pairs.length !== t1 - t0 ||
        pairs.some(([c, t]) => !sameShape(frag.get(c) as Y.XmlElement, target[t])));
    // Only a structural gap needs a source map; capture it before deleting containers can
    // collect their descendants.
    const before = rebuilt ? copyUnits(frag.toArray().slice(c0, c1) as Y.XmlElement[]) : null;
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
    for (const [c] of pairs) visit(frag.get(c) as Y.XmlElement);
    (frag.doc as Y.Doc).transact((transaction) => splitTextBoundaries(transaction, runs));
    const clock = Y.getState((frag.doc as Y.Doc).store, (frag.doc as Y.Doc).clientID);
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
        let text = el.get(0) as Y.XmlText | undefined;
        if (!text) {
          text = new Y.XmlText();
          el.insert(0, [text]);
        }
        editText(text, children(tgt));
        stats.edited++;
      } else if (preserve && sameShape(el, tgt)) {
        editContent(el, tgt);
        stats.edited++;
      } else {
        frag.delete(c, 1);
        frag.insert(c, [pmToY(tgt)]);
        stats.replaced++;
      }
    }
    if (before && copies)
      copies.push(
        ...copiedUnits(
          before,
          copyUnits(frag.toArray().slice(c0, c0 + t1 - t0) as Y.XmlElement[]),
          (frag.doc as Y.Doc).clientID,
          clock,
        ),
      );
  }
  return stats;
}

const children = (node: PMNode): PMNode[] => {
  const out: PMNode[] = [];
  node.forEach((child) => {
    out.push(child);
  });
  return out;
};

/** Adjacent marked PM text nodes share one XmlText. Atoms split runs, not whole paragraphs. */
function runs(node: PMNode): Array<PMNode | PMNode[]> {
  const out: Array<PMNode | PMNode[]> = [];
  node.forEach((child) => {
    const last = out.at(-1);
    if (!child.isText) out.push(child);
    else if (Array.isArray(last)) last.push(child);
    else out.push([child]);
  });
  return out;
}

function sameShape(el: Y.XmlElement, target: PMNode): boolean {
  const content = runs(target);
  return (
    el.nodeName === target.type.name &&
    el.length === content.length &&
    content.every((node, i) => {
      const child = el.get(i);
      return Array.isArray(node)
        ? child instanceof Y.XmlText
        : child instanceof Y.XmlElement && sameShape(child, node);
    })
  );
}

function editContent(el: Y.XmlElement, target: PMNode): void {
  editAttrs(el, target);
  runs(target).forEach((node, i) => {
    if (Array.isArray(node)) editText(el.get(i) as Y.XmlText, node);
    else editContent(el.get(i) as Y.XmlElement, node);
  });
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
  // Match whole words, as editText does. Character matching would falsely link the shared letters
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
