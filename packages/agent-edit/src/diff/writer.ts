/**
 * The minimal Yjs writer: writes target blocks into an XmlFragment as per-word edits so every item the
 * target leaves alone keeps its identity, and a peer's concurrent edits to those items survive.
 *
 * `correspond` says which block is which (equal blocks are untouched); a paired block is edited in
 * place, and a container is written the same way over its children. Inside a paragraph its atoms
 * (breaks, images) pair the same way, and the text run in each gap between them is reconciled where
 * it is. Text is diffed by word and written as inserts and deletes (insert first, as
 * `applyTextEdit` does), marks by `format`, attributes by set or remove. Only a block that pairs
 * with nothing (a type change) is deleted and rebuilt. Never use
 * `updateYFragment` here: its one prefix/suffix diff per text retypes everything between two edits, so a
 * peer's deletion in the middle would be undone.
 */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { splitTextBoundaries } from "../yjs-mutation.js";
import { TextRun } from "../yjs-text-runs.js";
import { correspond } from "./correspond.js";
import { readBlocks } from "./fragments.js";
import { type RestorationLink, recordWriteBack } from "./restorations.js";
import { diffKeys, splitWords, wordDiff } from "./tokens.js";

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
  inserted: number;
  deleted: number;
}

/** Edits one run of adjacent Y.XmlText into the target text and marks, touching only what changed. */
function editText(text: TextRun, target: readonly PMNode[]) {
  const cur = text
    .toDelta()
    .map((d) => d.insert)
    .join("");
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
  const delta = text.toDelta();
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
  const stats: WriteStats = { kept: 0, edited: 0, inserted: 0, deleted: 0 };
  writeChildren(frag, readBlocks(frag, schema), target, stats, copies, true);
  return stats;
}

/** A container (quote, list, table, ...) whose children are blocks: written child by child. */
const nests = (cur: PMNode, tgt: PMNode) =>
  cur.type === tgt.type && !tgt.isTextblock && cur.childCount > 0 && tgt.childCount > 0;

/**
 * Writes `target` into the block children of `parent`, which hold `current`. A paired container is
 * written the same way over its own children, so a block added or removed inside a quote, list or
 * table leaves the container's element, and anything aimed at it, in place. `record` says whether
 * this level maps restored copies back to their source (an enclosing rebuild already does).
 */
function writeChildren(
  parent: Y.XmlFragment | Y.XmlElement,
  current: readonly PMNode[],
  target: readonly PMNode[],
  stats: WriteStats,
  copies: RestorationLink[] | undefined,
  record: boolean,
): void {
  const { partner } = correspond(current, target);
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
    const rebuilt = copies !== undefined && (pairs.length !== c1 - c0 || pairs.length !== t1 - t0);
    // Only a structural gap needs a source map; capture it before deleting containers can
    // collect their descendants.
    const before =
      rebuilt && record ? copyUnits(parent.toArray().slice(c0, c1) as Y.XmlElement[]) : null;
    // Yjs splits with Array.splice. Pre-splitting in clock order keeps a full rewrite from
    // shifting all later paragraphs' new word items at each boundary; no clocks are allocated.
    // A nested level's items are inside the enclosing level's paired subtrees, already split.
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
        parent.insert(c + 1, ins.map(pmToY));
        stats.inserted += ins.length;
      }
      tPtr = t;
      if (c < c0) break;
      const el = parent.get(c) as Y.XmlElement;
      const tgt = target[t];
      if (nests(current[c], tgt)) {
        editAttrs(el, tgt);
        writeChildren(el, children(current[c]), children(tgt), stats, copies, record && !rebuilt);
        stats.edited++;
      } else {
        editContent(el, current[c], tgt);
        stats.edited++;
      }
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

const children = (node: PMNode): PMNode[] => {
  const out: PMNode[] = [];
  node.forEach((child) => {
    out.push(child);
  });
  return out;
};

/** An XmlText holding `nodes`, text with its marks. */
function textOf(nodes: readonly PMNode[]): Y.XmlText {
  const text = new Y.XmlText();
  let at = 0;
  for (const n of nodes) {
    text.insert(at, n.text ?? "", markAttrs(n));
    at += n.text?.length ?? 0;
  }
  return text;
}

/**
 * Edits an element to `target`, which has the type of the node `cur` it was read as. Its atoms
 * (breaks, images, inline nodes) pair with the target's by `correspond` and are edited in place,
 * an unpaired one is deleted or inserted where it stands. In each gap between two paired atoms
 * the text there is one run, because adjacent texts are one run (`yjs-text-runs.ts`), and it is
 * reconciled with the target's text of the gap: a run only the target has is created there, a run
 * only the element has is emptied, never deleted.
 */
function editContent(el: Y.XmlElement, cur: PMNode, target: PMNode): void {
  editAttrs(el, target);
  const atoms = el
    .toArray()
    .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
  const [curAtoms, targetKids] = [children(cur).filter((kid) => !kid.isText), children(target)];
  const tgtAtoms = targetKids.filter((kid) => !kid.isText);
  const { partner } = correspond(curAtoms, tgtAtoms);
  const atomAt = targetKids.flatMap((kid, at) => (kid.isText ? [] : [at]));
  const paired: Array<[number, number]> = [];
  partner.forEach((b, a) => {
    if (b >= 0) {
      editContent(atoms[a], curAtoms[a], tgtAtoms[b]);
      paired.push([a, b]);
    }
  });
  // Gaps right to left: [first atom, end atom] on each side, among the unpaired ones.
  const bounds = [...paired, [atoms.length, tgtAtoms.length] as [number, number]];
  for (let g = bounds.length - 1; g >= 0; g--) {
    const [aEnd, bEnd] = bounds[g];
    const [aFrom, bFrom] = g > 0 ? [bounds[g - 1][0] + 1, bounds[g - 1][1] + 1] : [0, 0];
    for (let a = aEnd - 1; a >= aFrom; a--) el.delete(el.toArray().indexOf(atoms[a]), 1);
    const kids = el.toArray();
    const from = g > 0 ? kids.indexOf(atoms[bounds[g - 1][0]]) + 1 : 0;
    const to = aEnd < atoms.length ? kids.indexOf(atoms[aEnd]) : kids.length;
    const texts = kids.slice(from, to) as Y.XmlText[];
    // The target's nodes in this gap, with its atoms and where they fall in its text.
    const [tStart, tEnd] = [
      bFrom > 0 ? atomAt[bFrom - 1] + 1 : 0,
      bEnd < tgtAtoms.length ? atomAt[bEnd] : targetKids.length,
    ];
    const wanted = targetKids.slice(tStart, tEnd);
    const wantedText = wanted.filter((n) => n.isText);
    if (texts.length === 0) {
      let run: PMNode[] = [];
      const made: Array<Y.XmlText | Y.XmlElement> = [];
      const flush = () => {
        if (run.length) made.push(textOf(run));
        run = [];
      };
      for (const n of wanted) {
        if (n.isText) run.push(n);
        else {
          flush();
          made.push(pmToY(n));
        }
      }
      flush();
      if (made.length) el.insert(from, made);
      continue;
    }
    editText(new TextRun(texts), wantedText);
    let offset = wantedText.reduce((sum, n) => sum + (n.text?.length ?? 0), 0);
    // Atoms from the last, so an earlier position is unmoved by a later split.
    for (let k = wanted.length - 1; k >= 0; k--) {
      if (wanted[k].isText) offset -= wanted[k].text?.length ?? 0;
      else insertAtom(el, texts, offset, pmToY(wanted[k]), from);
    }
  }
}

/**
 * Puts `atom` at `offset` in the run of `texts`, which starts at child `from` of `el`; inside a text,
 * its tail moves to a text after the atom. Atoms at one offset go in from the last, each before the
 * one inserted before it.
 */
function insertAtom(
  el: Y.XmlElement,
  texts: readonly Y.XmlText[],
  offset: number,
  atom: Y.XmlElement,
  from: number,
): void {
  let start = 0;
  for (const text of texts) {
    const end = start + text.length;
    if (offset <= end) {
      const index = el.toArray().indexOf(text);
      if (offset === end) el.insert(index + 1, [atom]);
      else if (offset === start) el.insert(from, [atom]);
      else {
        const tail = new Y.XmlText();
        let at = 0;
        let seen = 0;
        for (const part of text.toDelta() as Array<{ insert: string; attributes?: Attrs }>) {
          const skip = Math.max(0, offset - start - seen);
          seen += part.insert.length;
          if (skip >= part.insert.length) continue;
          const rest = part.insert.slice(skip);
          tail.insert(at, rest, part.attributes);
          at += rest.length;
        }
        text.delete(offset - start, end - offset);
        el.insert(index + 1, [atom, tail]);
      }
      return;
    }
    start = end;
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
