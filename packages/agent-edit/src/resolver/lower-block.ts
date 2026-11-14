import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Mark } from "prosemirror-model";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import { correspond } from "../diff/correspond.js";
import { wordDiff } from "../diff/tokens.js";
import type { EditOp, FormatRange, TextSplice } from "../ports/model.js";
import type { TextWindow } from "./find.js";

/** A model change: base units [from, to) become the model's units [at, end). */
interface Hunk {
  /** A find insert, which the model put after its match. */
  anchored?: true;
  from: number;
  to: number;
  at: number;
  end: number;
}

/** A block's Markdown as it sits in the document, with its `open` (see `ParseOptions`). */
export interface Where {
  body: string;
  open: string;
}

interface Walk {
  codec: AgentEditCodec;
  /** The top-level block as the model saw it. */
  top: Block;
  /** `top` as the document writes it, and the containers it sits in. */
  place: () => Where;
  /** What the codec shows of `top`: the attributes the model could have seen. */
  shown?: Block;
  /** A find's windows as units, by the path of the textblock that holds them. */
  windows: Map<string, [TextWindow[], TextWindow[]]> | null;
  ops: EditOp[];
}

/**
 * Lower a block rewrite planned on the model's view into the smallest operations on the
 * nodes, units and attributes the model saw. A replaced stretch is written whole, never trimmed.
 * Every node at any depth is lowered by the same code, and the room is never read. The two
 * blocks have one type; any other difference lowers: children that pair are edited in place,
 * the rest are deleted or inserted, and an inline atom may go into the middle of a run of text.
 * `placed` is a find's windows in the two blocks' text.
 */
export function lowerBlock(
  codec: AgentEditCodec,
  before: Block,
  after: Block,
  placed: [TextWindow[] | undefined, TextWindow[] | undefined] | null,
  place: () => Where,
): EditOp[] {
  const walk: Walk = {
    codec,
    top: before,
    place,
    windows: placed?.[0] && placed[1] ? unitWindows(before, after, placed[0], placed[1]) : null,
    ops: [],
  };
  lowerNode(walk, before, after, []);
  return walk.ops;
}

function lowerNode(walk: Walk, before: Block, after: Block, path: readonly number[]): void {
  if (before.eq(after)) return;
  const attrs = changedAttrs(before, after, () => shownNode(walk, path));
  if (Object.keys(attrs).length > 0) walk.ops.push({ kind: "attrs", path, attrs });
  if (before.isTextblock) {
    lowerTextblock(walk, before, after, path);
    return;
  }
  lowerChildren(walk, before, after, path);
}

/**
 * A container's children pair by `correspond` (by id where nodes have ids, by guess where they
 * do not); a pair of one type is edited in place, a child with no pair is deleted, and a run of
 * new children with none goes in after the last pair before it.
 */
function lowerChildren(walk: Walk, before: Block, after: Block, path: readonly number[]): void {
  const olds = childrenOf(before);
  const news = childrenOf(after);
  const { partner, moved } = correspond(olds, news, { byId: true });
  const paired = partner.map((next, old) =>
    next >= 0 && !moved.has(old) && olds[old].type === news[next].type ? next : -1,
  );
  const back = new Int32Array(news.length).fill(-1);
  paired.forEach((next, old) => {
    if (next >= 0) back[next] = old;
  });
  let run: { after: number; nodes: Block[] } | undefined;
  let anchor = -1;
  for (const [next, node] of news.entries()) {
    if (back[next] >= 0) {
      anchor = back[next];
      run = undefined;
      continue;
    }
    if (!run) {
      run = { after: anchor, nodes: [] };
      walk.ops.push({ kind: "insert", path, after: anchor, nodes: run.nodes });
    }
    run.nodes.push(node);
  }
  for (const [old, next] of paired.entries()) {
    if (next >= 0) lowerNode(walk, olds[old], news[next], [...path, old]);
    else walk.ops.push({ kind: "delete", path: [...path, old] });
  }
}

function childrenOf(node: Block): Block[] {
  const found: Block[] = [];
  node.forEach((child) => {
    found.push(child);
  });
  return found;
}

/**
 * The attributes the model changed: those where its node differs from what the codec
 * shows of the node it saw. An attribute the codec does not write (an upload in flight)
 * comes back the same from both, so the model never overwrites what it was never shown.
 */
function changedAttrs(
  before: Block,
  after: Block,
  shownOf: () => Block | null,
): Record<string, unknown> {
  const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  const candidates = Object.keys(after.attrs).filter((key) =>
    differs(before.attrs[key], after.attrs[key]),
  );
  const changed: Record<string, unknown> = {};
  if (candidates.length === 0) return changed;
  // A node the codec's round trip has no counterpart of shows nothing: write no attribute.
  const shown = shownOf();
  if (!shown) return changed;
  for (const key of candidates)
    if (differs(shown.attrs[key], after.attrs[key])) changed[key] = after.attrs[key];
  return changed;
}

/**
 * The node at `path` in the codec's round trip of the top-level block, read where it sits: a
 * further paragraph of an item read alone would start an item. A block that opens two lists at
 * once parses after the empty paragraph that carries the outer item, so its block is the last.
 */
function shownNode(walk: Walk, path: readonly number[]): Block | null {
  if (!walk.shown) {
    const { body, open } = walk.place();
    walk.shown = walk.codec.parse(body, { within: open }).blocks.at(-1);
  }
  let node: Block | null | undefined = walk.shown;
  for (const index of path) node = node?.maybeChild(index);
  return node ?? null;
}

/** The `ordinal`th inline atom of the textblock at `path` in the codec's round trip. */
function shownAtom(walk: Walk, path: readonly number[], ordinal: number): Block | null {
  const atoms: Block[] = [];
  shownNode(walk, path)?.forEach((child) => {
    if (!child.isText) atoms.push(child);
  });
  return atoms[ordinal] ?? null;
}

function lowerTextblock(walk: Walk, before: Block, after: Block, path: readonly number[]): void {
  const text = lowerText(before, after, walk.windows?.get(path.join("/")));
  if (text.splices.length + text.formats.length > 0)
    walk.ops.push({ kind: "text", path, splices: text.splices, formats: text.formats });
  // An atom the model kept is one the room may have changed: only the model's attributes go.
  for (const { unit, modelUnit, ordinal } of text.kept) {
    const was = before.nodeAt(unit);
    const now = after.nodeAt(modelUnit);
    if (!was || !now) continue;
    const attrs = changedAttrs(was, now, () => shownAtom(walk, path, ordinal));
    if (Object.keys(attrs).length > 0) walk.ops.push({ kind: "attrs", path, attrs, unit });
  }
}

interface LoweredText {
  splices: TextSplice[];
  formats: FormatRange[];
  /** Inline atoms the model kept, by unit in the view and in the model's text. */
  kept: Array<{ unit: number; modelUnit: number; ordinal: number }>;
}

/**
 * The units of a textblock as a string: its text, and one character per inline atom type,
 * the same on both sides. Atoms compare by type; a changed attribute is a change to the atom.
 * A character no text holds stands for each type, so no text can pass for an atom.
 */
function unitStrings(before: Block, after: Block) {
  const text = before.textContent + after.textContent;
  const codes = new Map<string, string>();
  let next = 0xe000;
  const code = (type: string) => {
    let found = codes.get(type);
    if (!found) {
      do found = String.fromCharCode(next++);
      while (text.includes(found));
      codes.set(type, found);
    }
    return found;
  };
  const units = (block: Block) => {
    let value = "";
    block.forEach((child) => {
      value += child.isText ? child.text : code(child.type.name);
    });
    return value;
  };
  const a = units(before);
  const b = units(after);
  const atoms = new Set(codes.values());
  return { a, b, isAtom: (unit: string, at: number) => atoms.has(unit[at]) };
}

function lowerText(
  before: Block,
  after: Block,
  placed: [TextWindow[], TextWindow[]] | undefined,
): LoweredText {
  const { a, b, isAtom } = unitStrings(before, after);

  // A find's window is one change, placed by the model; otherwise the word diff places them.
  let hunks: Hunk[] = [];
  const olds = placed?.[0];
  const news = placed?.[1];
  if (olds && news && windowsDescribe(a, b, [olds, news])) {
    for (const [index, old] of olds.entries()) {
      const next = news[index];
      // A cut that rewrites its text unchanged (marks included) is no edit.
      if (
        old.to > old.from &&
        before.content.cut(old.from, old.to).eq(after.content.cut(next.from, next.to))
      )
        continue;
      hunks.push({
        from: old.from,
        to: old.to,
        at: next.from,
        end: next.to,
        ...(old.from === old.to ? { anchored: true as const } : {}),
      });
    }
  } else {
    hunks = wordHunks(a, b);
  }

  hunks = hunks.filter((hunk) => hunk.from < hunk.to || hunk.at < hunk.end);
  slideAtomInserts(hunks, a, b, isAtom);

  const splices: TextSplice[] = hunks.map((hunk) => ({
    from: hunk.from,
    to: hunk.to,
    content: after.content.cut(hunk.at, hunk.end),
  }));
  const { formats, kept } = keptUnits(before, after, hunks);
  return { splices, formats, kept };
}

/**
 * An inline atom is a child of the textblock, not a character of a run of text, and a run
 * cannot be cut without moving its tail to a run of its own, which sends a peer's typing in the
 * tail elsewhere. So an insert that puts an atom inside a run slides over equal text to the
 * nearest run edge; the model's own find insert, and any change that replaces text, cut the run.
 */
function slideAtomInserts(
  hunks: Hunk[],
  a: string,
  b: string,
  isAtom: (units: string, at: number) => boolean,
): void {
  const size = a.length;
  const midRun = (at: number) => at > 0 && at < size && !isAtom(a, at - 1) && !isAtom(a, at);
  for (const [index, hunk] of hunks.entries()) {
    if (hunk.from !== hunk.to || hunk.anchored || !midRun(hunk.from)) continue;
    if (![...b.slice(hunk.at, hunk.end)].some((_, i) => isAtom(b, hunk.at + i))) continue;
    const floor = hunks[index - 1]?.to ?? 0;
    const ceiling = hunks[index + 1]?.from ?? size;
    for (let k = 1; k <= hunk.end - hunk.at; k += 1) {
      const back =
        hunk.from - k >= floor &&
        !midRun(hunk.from - k) &&
        a.slice(hunk.from - k, hunk.from) === b.slice(hunk.end - k, hunk.end);
      const forward =
        hunk.from + k <= ceiling &&
        !midRun(hunk.from + k) &&
        a.slice(hunk.from, hunk.from + k) === b.slice(hunk.at, hunk.at + k);
      if (!back && !forward) continue;
      const by = back ? -k : k;
      hunk.from += by;
      hunk.to += by;
      hunk.at += by;
      hunk.end += by;
      break;
    }
  }
}

/** The word diff of two unit strings as hunks: base units [from, to) become the model's [at, end). */
function wordHunks(a: string, b: string): Hunk[] {
  const hunks: Hunk[] = [];
  let base = 0;
  let model = 0;
  let open: Hunk | undefined;
  for (const [op, text] of wordDiff(a, b)) {
    if (op === DIFF_EQUAL) {
      open = undefined;
      base += text.length;
      model += text.length;
      continue;
    }
    open ??= hunks[hunks.push({ from: base, to: base, at: model, end: model }) - 1];
    if (op === DIFF_DELETE) {
      base += text.length;
      open.to = base;
    }
    if (op === DIFF_INSERT) {
      model += text.length;
      open.end = model;
    }
  }
  return hunks;
}

/**
 * What the model left alone, between the hunks: its formatting changes, compared only there
 * since new text carries its own marks inside its splice, and the inline atoms it kept.
 */
function keptUnits(
  before: Block,
  after: Block,
  hunks: readonly Hunk[],
): { formats: FormatRange[]; kept: LoweredText["kept"] } {
  const marksA = unitMarks(before);
  const marksB = unitMarks(after);
  const names = new Set<string>();
  for (const marks of [...marksA, ...marksB])
    for (const mark of marks ?? []) names.add(mark.type.name);
  const value = (marks: readonly Mark[], name: string) => {
    const mark = marks.find((candidate) => candidate.type.name === name);
    return mark ? JSON.stringify(mark.attrs) : null;
  };
  const formats: FormatRange[] = [];
  const kept: LoweredText["kept"] = [];
  let ordinal = 0;
  let base = 0;
  let model = 0;
  for (const hunk of [...hunks, { from: marksA.length, to: marksA.length, at: 0, end: 0 }]) {
    for (let unit = base; unit < hunk.from; unit += 1)
      if (marksA[unit] === null)
        kept.push({ unit, modelUnit: model + unit - base, ordinal: ordinal++ });
    for (const name of names) {
      let open: FormatRange | undefined;
      let want: string | null = null;
      for (let unit = base; unit < hunk.from; unit += 1) {
        const mine = marksA[unit];
        const theirs = marksB[model + unit - base];
        // An atom carries no marks.
        if (mine === null || theirs === null) {
          open = undefined;
          continue;
        }
        const now = value(mine, name);
        const next = value(theirs, name);
        if (now === next) {
          open = undefined;
        } else if (open && want === next && open.to === unit) {
          open.to = unit + 1;
        } else {
          want = next;
          open = {
            from: unit,
            to: unit + 1,
            mark: name,
            attrs: next === null ? null : (JSON.parse(next) as Record<string, unknown>),
          };
          formats.push(open);
        }
      }
    }
    // Atoms in a hunk are not kept, but they still count in the textblock's order.
    for (let unit = hunk.from; unit < hunk.to; unit += 1) if (marksA[unit] === null) ordinal += 1;
    base = hunk.to;
    model = hunk.end;
  }
  return { formats, kept };
}

/** The marks on each unit of a textblock; null for an inline atom, which carries none. */
function unitMarks(block: Block): Array<readonly Mark[] | null> {
  const marks: Array<readonly Mark[] | null> = [];
  block.forEach((child) => {
    if (child.isText)
      for (let n = 0; n < (child.text?.length ?? 0); n += 1) marks.push(child.marks);
    else marks.push(null);
  });
  return marks;
}

/**
 * A find's windows, given in each block's `textContent`, as unit windows per textblock, by
 * the path of the textblock in the block. Null when the two blocks do not hold the same
 * textblocks or a window crosses one.
 */
function unitWindows(
  before: Block,
  after: Block,
  olds: readonly TextWindow[],
  news: readonly TextWindow[],
): Map<string, [TextWindow[], TextWindow[]]> | null {
  if (olds.length !== news.length) return null;
  const a = textblocksOf(before);
  const b = textblocksOf(after);
  if (a.length !== b.length) return null;
  const placed = new Map<string, [TextWindow[], TextWindow[]]>();
  for (const [index, old] of olds.entries()) {
    const next = news[index];
    // An empty window at a textblock's end belongs to it: an insert goes after its match.
    const at = a.findIndex(
      (candidate) => old.from >= candidate.start && old.to <= candidate.start + candidate.length,
    );
    if (at < 0 || a[at].key !== b[at].key) return null;
    // The model's window sits in the same textblock: the find changed text, not structure.
    if (next.from < b[at].start || next.to > b[at].start + b[at].length) return null;
    const entry = placed.get(a[at].key) ?? [[], []];
    entry[0].push(unitWindow(a[at], old));
    entry[1].push(unitWindow(b[at], next));
    placed.set(a[at].key, entry);
  }
  return placed;
}

interface TextblockText {
  node: Block;
  /** The textblock's path in the block, joined. */
  key: string;
  /** Offset of its first character in the block's `textContent`. */
  start: number;
  length: number;
}

function textblocksOf(block: Block): TextblockText[] {
  const found: TextblockText[] = [];
  let start = 0;
  const visit = (node: Block, path: readonly number[]) => {
    if (node.isTextblock) {
      found.push({ node, key: path.join("/"), start, length: node.textContent.length });
      start += node.textContent.length;
    } else {
      node.forEach((child, _offset, index) => {
        visit(child, [...path, index]);
      });
    }
  };
  visit(block, []);
  return found;
}

/** Text offsets to unit offsets: an inline atom is a unit but no character. */
function unitWindow(textblock: TextblockText, window: TextWindow): TextWindow {
  const unitOf: number[] = [];
  let unit = 0;
  textblock.node.forEach((child) => {
    if (child.isText) for (let n = 0; n < (child.text?.length ?? 0); n += 1) unitOf.push(unit++);
    else unit += 1;
  });
  const from = window.from - textblock.start;
  const to = window.to - textblock.start;
  const after = (char: number) => (char <= 0 ? 0 : unitOf[char - 1] + 1);
  return from === to
    ? { from: after(from), to: after(from) }
    : { from: unitOf[from], to: after(to) };
}

/** Whether the text outside the windows is the same in both blocks, so they place the edit. */
function windowsDescribe(
  a: string,
  b: string,
  [olds, news]: [TextWindow[], TextWindow[]],
): boolean {
  if (olds.length !== news.length) return false;
  let oldCursor = 0;
  let newCursor = 0;
  for (const [index, old] of olds.entries()) {
    const next = news[index];
    if (a.slice(oldCursor, old.from) !== b.slice(newCursor, next.from)) return false;
    oldCursor = old.to;
    newCursor = next.to;
  }
  return a.slice(oldCursor) === b.slice(newCursor);
}
