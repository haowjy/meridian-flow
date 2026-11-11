import type { Mark } from "prosemirror-model";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import type { EditOp, FormatRange, TextSplice } from "../ports/model.js";
import { wordHunks } from "../word-hunks.js";
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

/** The pair has a shape the lowering cannot keep: a node was added, removed or retyped. */
class Unsupported extends Error {}

interface Walk {
  codec: AgentEditCodec;
  /** The top-level block as the model saw it. */
  top: Block;
  /** What the codec shows of `top`: the attributes the model could have seen. */
  shown?: Block;
  /** A find's windows as units, by the path of the textblock that holds them. */
  windows: Map<string, [TextWindow[], TextWindow[]]> | null;
  ops: EditOp[];
}

/**
 * Lower a block rewrite planned on the model's view into the smallest operations on the
 * units and attributes the model saw: a replaced stretch keeps the letters its old and new
 * text share at the edges and changes only the middle.
 * Every textblock at any depth is lowered by the same code, and the room is never read.
 * `placed` is a find's windows in the two blocks' text. Null for a shape this
 * lowering does not keep (a node added, removed or retyped, an inline atom put inside a run
 * of text), which the caller rewrites as a whole block.
 */
export function lowerBlock(
  codec: AgentEditCodec,
  before: Block,
  after: Block,
  placed: [TextWindow[] | undefined, TextWindow[] | undefined] | null,
): EditOp[] | null {
  if (!sameShape(before, after)) return null;
  const walk: Walk = {
    codec,
    top: before,
    windows: placed?.[0] && placed[1] ? unitWindows(before, after, placed[0], placed[1]) : null,
    ops: [],
  };
  try {
    lowerNode(walk, before, after, []);
  } catch (cause) {
    if (cause instanceof Unsupported) return null;
    throw cause;
  }
  return walk.ops;
}

function sameShape(before: Block, after: Block): boolean {
  if (before.type !== after.type) return false;
  if (before.isTextblock) return true;
  if (before.childCount !== after.childCount) return false;
  for (let index = 0; index < before.childCount; index += 1)
    if (!sameShape(before.child(index), after.child(index))) return false;
  return true;
}

function lowerNode(walk: Walk, before: Block, after: Block, path: readonly number[]): void {
  if (before.eq(after)) return;
  const attrs = changedAttrs(before, after, () => shownNode(walk, path));
  if (Object.keys(attrs).length > 0) walk.ops.push({ kind: "attrs", path, attrs });
  if (before.isTextblock) {
    lowerTextblock(walk, before, after, path);
    return;
  }
  for (let index = 0; index < before.childCount; index += 1)
    lowerNode(walk, before.child(index), after.child(index), [...path, index]);
}

/**
 * The attributes the model changed: those where its node differs from what the codec
 * shows of the node it saw. An attribute the codec does not write (an upload in flight)
 * comes back the same from both, so the model never overwrites what it was never shown.
 */
function changedAttrs(before: Block, after: Block, shownOf: () => Block): Record<string, unknown> {
  const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  const candidates = Object.keys(after.attrs).filter((key) =>
    differs(before.attrs[key], after.attrs[key]),
  );
  const changed: Record<string, unknown> = {};
  if (candidates.length === 0) return changed;
  const shown = shownOf();
  for (const key of candidates)
    if (differs(shown.attrs[key], after.attrs[key])) changed[key] = after.attrs[key];
  return changed;
}

/** The node at `path` in the codec's round trip of the top-level block. */
function shownNode(walk: Walk, path: readonly number[]): Block {
  walk.shown ??= walk.codec.parse(walk.codec.serialize([walk.top])).blocks[0];
  let node: Block | null | undefined = walk.shown;
  for (const index of path) node = node?.maybeChild(index);
  if (!node) throw new Unsupported();
  return node;
}

/** The `ordinal`th inline atom of the textblock at `path` in the codec's round trip. */
function shownAtom(walk: Walk, path: readonly number[], ordinal: number): Block {
  const atoms: Block[] = [];
  shownNode(walk, path).forEach((child) => {
    if (!child.isText) atoms.push(child);
  });
  const atom = atoms[ordinal];
  if (!atom) throw new Unsupported();
  return atom;
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
  const size = a.length;

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
    let shift = 0;
    for (const hunk of wordHunks(a, b)) {
      hunks.push({
        from: hunk.from,
        to: hunk.to,
        at: hunk.from + shift,
        end: hunk.from + shift + hunk.text.length,
      });
      shift += hunk.text.length - (hunk.to - hunk.from);
    }
  }

  hunks = hunks.filter((hunk) => hunk.from < hunk.to || hunk.at < hunk.end);

  // An inline atom is a child of the textblock, not a character of a run of text, so a
  // change that puts one in goes between runs: an insert slides over equal text to the
  // nearest edge; any other is a shape this lowering does not keep.
  const hasAtom = (hunk: Hunk) =>
    [...b.slice(hunk.at, hunk.end)].some((_, i) => isAtom(b, hunk.at + i));
  const midRun = (from: number, to: number) => {
    if (from === 0 || to === size || isAtom(a, from - 1) || isAtom(a, to)) return false;
    for (let at = from; at < to; at += 1) if (isAtom(a, at)) return false;
    return true;
  };
  for (const [index, hunk] of hunks.entries()) {
    if (!hasAtom(hunk) || !midRun(hunk.from, hunk.to)) continue;
    if (hunk.from !== hunk.to || hunk.anchored) throw new Unsupported();
    const floor = hunks[index - 1]?.to ?? 0;
    const ceiling = hunks[index + 1]?.from ?? size;
    let slid = false;
    for (let k = 1; k <= hunk.end - hunk.at && !slid; k += 1) {
      if (
        hunk.from - k >= floor &&
        !midRun(hunk.from - k, hunk.from - k) &&
        a.slice(hunk.from - k, hunk.from) === b.slice(hunk.end - k, hunk.end)
      ) {
        slid = true;
        hunk.from -= k;
        hunk.to -= k;
        hunk.at -= k;
        hunk.end -= k;
      } else if (
        hunk.from + k <= ceiling &&
        !midRun(hunk.from + k, hunk.from + k) &&
        a.slice(hunk.from, hunk.from + k) === b.slice(hunk.at, hunk.at + k)
      ) {
        slid = true;
        hunk.from += k;
        hunk.to += k;
        hunk.at += k;
        hunk.end += k;
      }
    }
    if (!slid) throw new Unsupported();
  }

  const splices: TextSplice[] = hunks.map((hunk) => ({
    from: hunk.from,
    to: hunk.to,
    content: after.content.cut(hunk.at, hunk.end),
  }));
  const { formats, kept } = keptUnits(before, after, hunks);
  return { splices, formats, kept };
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
