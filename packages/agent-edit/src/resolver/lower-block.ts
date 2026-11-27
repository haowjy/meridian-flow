import { DIFF_DELETE, DIFF_EQUAL } from "@sanity/diff-match-patch";
import { Fragment, Mark } from "prosemirror-model";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import { correspond } from "../diff/correspond.js";
import { diffKeys, segmentText, wordDiff } from "../diff/tokens.js";
import type { EditOp, EditorOf, FormatRange, TextSplice } from "../ports/model.js";
import type { TextWindow } from "./find.js";

interface Hunk {
  anchored?: true;
  from: number;
  to: number;
  at: number;
  end: number;
}

export interface Where {
  body: string;
  open: string;
}

export interface ShownBy {
  codec: AgentEditCodec;
  place: () => Where;
}

interface Walk {
  shownBy?: ShownBy;
  editors?: (path: readonly number[]) => EditorOf;
  shown?: Block;
  windows: Map<string, [TextWindow[], TextWindow[]]> | null;
  ops: EditOp[];
}

export function lowerBlock(
  before: Block,
  after: Block,
  options: {
    placed?: [TextWindow[] | undefined, TextWindow[] | undefined] | null;
    shownBy?: ShownBy;
    editors?: (path: readonly number[]) => EditorOf;
  } = {},
): EditOp[] {
  const { placed, shownBy, editors } = options;
  const walk: Walk = {
    shownBy,
    editors,
    windows: placed?.[0] && placed[1] ? unitWindows(before, after, placed[0], placed[1]) : null,
    ops: [],
  };
  lowerNode(walk, before, after, []);
  return walk.ops;
}

function lowerNode(walk: Walk, before: Block, after: Block, path: readonly number[]): void {
  if (before.eq(after)) return;
  const attrs = changedAttrs(before, after, walk.shownBy && (() => shownNode(walk, path)));
  if (Object.keys(attrs).length > 0) walk.ops.push({ kind: "attrs", path, attrs });
  if (before.isTextblock) {
    lowerTextblock(walk, before, after, path);
    return;
  }
  lowerChildren(walk, before, after, path);
}

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

function changedAttrs(
  before: Block,
  after: Block,
  shownOf: (() => Block | null) | undefined,
): Record<string, unknown> {
  const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  const candidates = Object.keys(after.attrs).filter((key) =>
    differs(before.attrs[key], after.attrs[key]),
  );
  const changed: Record<string, unknown> = {};
  if (!shownOf) {
    for (const key of candidates) changed[key] = after.attrs[key];
    return changed;
  }
  if (candidates.length === 0) return changed;
  const shown = shownOf();
  if (!shown) return changed;
  for (const key of candidates)
    if (differs(shown.attrs[key], after.attrs[key])) changed[key] = after.attrs[key];
  return changed;
}

function shownNode(walk: Walk, path: readonly number[]): Block | null {
  if (!walk.shown && walk.shownBy) {
    const { body, open } = walk.shownBy.place();
    walk.shown = walk.shownBy.codec.parse(body, { within: open }).blocks.at(-1);
  }
  let node: Block | null | undefined = walk.shown;
  for (const index of path) node = node?.maybeChild(index);
  return node ?? null;
}

function shownAtom(walk: Walk, path: readonly number[], ordinal: number): Block | null {
  const atoms: Block[] = [];
  shownNode(walk, path)?.forEach((child) => {
    if (!child.isText) atoms.push(child);
  });
  return atoms[ordinal] ?? null;
}

function lowerTextblock(walk: Walk, before: Block, after: Block, path: readonly number[]): void {
  const text = lowerText(before, after, walk.windows?.get(path.join("/")), walk.editors?.(path));
  if (text.splices.length + text.formats.length > 0)
    walk.ops.push({ kind: "text", path, splices: text.splices, formats: text.formats });
  for (const { unit, modelUnit, ordinal } of text.kept) {
    const was = before.nodeAt(unit);
    const now = after.nodeAt(modelUnit);
    if (!was || !now) continue;
    const attrs = changedAttrs(was, now, walk.shownBy && (() => shownAtom(walk, path, ordinal)));
    if (Object.keys(attrs).length > 0) walk.ops.push({ kind: "attrs", path, attrs, unit });
  }
}

interface LoweredText {
  splices: TextSplice[];
  formats: FormatRange[];
  kept: Array<{ unit: number; modelUnit: number; ordinal: number }>;
}

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
  editorOf: EditorOf | undefined,
): LoweredText {
  const { a, b, isAtom } = unitStrings(before, after);

  const whole: [TextWindow[], TextWindow[]] = [
    [{ from: 0, to: a.length }],
    [{ from: 0, to: b.length }],
  ];
  const [olds, news] =
    placed?.[0] && placed[1] && windowsDescribe(a, b, [placed[0], placed[1]])
      ? [placed[0], placed[1]]
      : whole;
  const changes: Hunk[] = [];
  let hunks: Hunk[] = [];
  for (const [index, old] of olds.entries()) {
    const next = news[index];
    if (old.from === old.to) {
      changes.push({ from: old.from, to: old.to, at: next.from, end: next.to });
      hunks.push({ from: old.from, to: old.to, at: next.from, end: next.to, anchored: true });
      continue;
    }
    const words = wordHunks(a.slice(old.from, old.to), b.slice(next.from, next.to)).map((hunk) => ({
      from: hunk.from + old.from,
      to: hunk.to + old.from,
      at: hunk.at + next.from,
      end: hunk.end + next.from,
    }));
    changes.push(...words);
    const pieces = words.flatMap((hunk) => retainShared(a, b, hunk, isAtom));
    hunks.push(...keepOneSpace(a, b, pieces, old, editorOf));
  }

  hunks = hunks.filter((hunk) => hunk.from < hunk.to || hunk.at < hunk.end);
  slideAtomInserts(hunks, a, b, isAtom);
  return textOps(before, after, hunks, changes, a, b);
}

function textOps(
  before: Block,
  after: Block,
  hunks: readonly Hunk[],
  changes: readonly Hunk[],
  a: string,
  b: string,
): LoweredText {
  const marksA = unitMarks(before);
  const marksB = unitMarks(after);
  const carried = carriedMarks(a, b, marksA, changes);
  const names = new Set<string>();
  for (const marks of [...marksA, ...marksB])
    for (const mark of marks ?? [])
      if (mark.type.spec.markdown !== false) names.add(mark.type.name);
  const value = (marks: readonly Mark[], key: string) => {
    const mark = marks.find((candidate) => candidate.type.name === key);
    return mark ? JSON.stringify(mark.attrs) : null;
  };
  const splices: TextSplice[] = [];
  const formats: FormatRange[] = [];
  const kept: LoweredText["kept"] = [];
  let ordinal = 0;
  let base = 0;
  let model = 0;
  const last = { from: marksA.length, to: marksA.length, at: 0, end: 0 };
  for (const hunk of [...hunks, last]) {
    for (let unit = base; unit < hunk.from; unit += 1)
      if (marksA[unit] === null)
        kept.push({ unit, modelUnit: model + unit - base, ordinal: ordinal++ });
    for (const name of names) {
      let open: FormatRange | undefined;
      let want: string | null = null;
      for (let unit = base; unit < hunk.from; unit += 1) {
        const mine = marksA[unit];
        const theirs = marksB[model + unit - base];
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
    if (hunk === last) break;
    splices.push({ from: hunk.from, to: hunk.to, content: newText(after, hunk, carried) });
    for (let unit = hunk.from; unit < hunk.to; unit += 1) if (marksA[unit] === null) ordinal += 1;
    base = hunk.to;
    model = hunk.end;
  }
  return { splices, formats, kept };
}

function newText(after: Block, { at, end }: Hunk, carried: ReadonlyArray<readonly Mark[]>) {
  const nodes: Block[] = [];
  let unit = at;
  after.content.cut(at, end).forEach((node) => {
    const size = node.isText ? (node.text?.length ?? 0) : 1;
    if (!node.isText) nodes.push(node);
    else
      for (let from = 0, to = 1; to <= size; to += 1) {
        const marks = carried[unit + from];
        if (to < size && Mark.sameSet(carried[unit + to], marks)) continue;
        const own = marks.reduce((set, mark) => mark.addToSet(set), node.marks);
        nodes.push(node.cut(from, to).mark(own));
        from = to;
      }
    unit += size;
  });
  return Fragment.fromArray(nodes);
}

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

const isSpace = (unit: string | undefined) => unit !== undefined && /\s/.test(unit);
const deletes = (hunk: Hunk) => hunk.from < hunk.to;

function keepOneSpace(
  a: string,
  b: string,
  pieces: readonly Hunk[],
  window: TextWindow,
  editorOf: EditorOf | undefined,
): Hunk[] {
  const merged: Hunk[] = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if (last && deletes(last) && deletes(piece) && /^\s*$/.test(a.slice(last.to, piece.from))) {
      last.to = piece.to;
      last.end = piece.end;
    } else merged.push({ ...piece });
  }
  const sameEditor = (x: number, y: number) =>
    editorOf !== undefined && x >= 0 && y < a.length && editorOf(x) === editorOf(y);
  return merged.map((hunk, index) => {
    if (!/\S/.test(a.slice(hunk.from, hunk.to))) return hunk;
    const prev = merged[index - 1];
    const next = merged[index + 1];
    const floor = prev ? prev.to + (deletes(prev) ? 0 : 1) : window.from;
    const ceiling = next ? next.from - (deletes(next) ? 0 : 1) : window.to;
    let { from, to, at, end } = hunk;
    while (from > floor && isSpace(a[from - 1])) [from, at] = [from - 1, at - 1];
    while (to < ceiling && isSpace(a[to])) [to, end] = [to + 1, end + 1];
    const keepsBefore = !isSpace(a[from]) || sameEditor(from - 1, from);
    const keepsAfter = !isSpace(a[to - 1]) || sameEditor(to - 1, to);
    if (editorOf && keepsBefore && !keepsAfter)
      while (from < to && at < end && isSpace(a[from]) && b[at] === a[from])
        [from, at] = [from + 1, at + 1];
    else
      while (to > from && end > at && isSpace(a[to - 1]) && b[end - 1] === a[to - 1])
        [to, end] = [to - 1, end - 1];
    return { from, to, at, end };
  });
}

function carriedMarks(
  a: string,
  b: string,
  marks: Marks,
  changes: readonly Hunk[],
): Array<readonly Mark[]> {
  const none: readonly Mark[] = [];
  const hidden = (unit: number) =>
    marks[unit]?.filter((mark) => mark.type.spec.markdown === false) ?? none;
  const out: Array<readonly Mark[]> = new Array(b.length);
  const both = (x: readonly Mark[], y: readonly Mark[]) => x.filter((mark) => mark.isInSet(y));
  let base = 0;
  let model = 0;
  for (const change of [
    ...changes,
    { from: a.length, to: a.length, at: b.length, end: b.length },
  ]) {
    while (model < change.at) out[model++] = hidden(base++);
    const olds = wordsIn(a, change.from, change.to);
    const news = wordsIn(b, change.at, change.end);
    const sources: number[][] = news.map(() => []);
    if (news.length > 0)
      for (const i of olds.keys())
        sources[Math.floor(((2 * i + 1) * news.length) / (2 * olds.length))].push(i);
    for (const [j, list] of sources.entries())
      if (list.length === 0 && olds.length > 0)
        list.push(Math.floor(((2 * j + 1) * olds.length) / (2 * news.length)));
    for (let unit = change.at; unit < change.end; unit += 1) out[unit] = none;
    for (const [j, word] of news.entries()) {
      let set = none;
      for (const i of sources[j])
        for (let unit = olds[i].from; unit < olds[i].to; unit += 1)
          for (const mark of hidden(unit)) set = mark.addToSet(set);
      for (let unit = word.from; unit < word.to; unit += 1) out[unit] = set;
    }
    for (let j = 0; j <= news.length; j += 1) {
      const gapFrom = j > 0 ? news[j - 1].to : change.at;
      const gapTo = j < news.length ? news[j].from : change.end;
      if (gapFrom === gapTo) continue;
      const left = gapFrom > 0 ? out[gapFrom - 1] : none;
      const right = j < news.length ? out[gapTo] : change.to < a.length ? hidden(change.to) : none;
      let set = both(left, right);
      const l = j > 0 ? sources[j - 1].at(-1) : -1;
      const r = j < news.length ? sources[j][0] : olds.length;
      if (l === undefined || r === undefined || l < r) {
        const oldFrom = l === undefined || l < 0 ? change.from : olds[l].to;
        const oldTo = r === undefined || r >= olds.length ? change.to : olds[r].from;
        for (let unit = oldFrom; unit < oldTo; unit += 1) set = both(set, hidden(unit));
      }
      for (let unit = gapFrom; unit < gapTo; unit += 1) out[unit] = set;
    }
    base = change.to;
    model = change.end;
  }
  return out;
}

function wordsIn(units: string, from: number, to: number): TextWindow[] {
  const found: TextWindow[] = [];
  let at = from;
  for (const { segment, space } of segmentText(units.slice(from, to))) {
    if (!space) found.push({ from: at, to: at + segment.length });
    at += segment.length;
  }
  return found;
}

function wordHunks(a: string, b: string): Hunk[] {
  const hunks: Hunk[] = [];
  let base = 0;
  let model = 0;
  let open: Hunk | undefined;
  for (const { kind, text } of wordDiff(a, b)) {
    if (kind === "same") {
      open = undefined;
      base += text.length;
      model += text.length;
      continue;
    }
    open ??= hunks[hunks.push({ from: base, to: base, at: model, end: model }) - 1];
    if (kind === "removed") {
      base += text.length;
      open.to = base;
    }
    if (kind === "added") {
      model += text.length;
      open.end = model;
    }
  }
  return hunks;
}

function retainShared(
  a: string,
  b: string,
  hunk: Hunk,
  isAtom: (units: string, at: number) => boolean,
): Hunk[] {
  if (hunk.from === hunk.to || hunk.at === hunk.end) return [hunk];
  const keys = (text: string, from: number, to: number) => {
    const chars = Array.from(text.slice(from, to));
    let at = from;
    const unique = chars.map((char) => {
      const key = isAtom(char, 0) ? `${char}${at}` : char;
      at += char.length;
      return key;
    });
    return { unique, widths: chars.map((char) => char.length) };
  };
  const before = keys(a, hunk.from, hunk.to);
  const after = keys(b, hunk.at, hunk.end);
  const ops = diffKeys(before.unique, after.unique);
  if (ops.some(([op]) => op === DIFF_DELETE)) return [hunk];
  const out: Hunk[] = [];
  let base = hunk.from;
  let model = hunk.at;
  let open: Hunk | undefined;
  let [x, y] = [0, 0];
  for (const [op, n] of ops) {
    if (op === DIFF_EQUAL) {
      open = undefined;
      for (let k = 0; k < n; k++) {
        base += before.widths[x++];
        model += after.widths[y++];
      }
      continue;
    }
    open ??= out[out.push({ from: base, to: base, at: model, end: model }) - 1];
    for (let k = 0; k < n; k++) {
      if (op === DIFF_DELETE) base += before.widths[x++];
      else model += after.widths[y++];
    }
    open.to = base;
    open.end = model;
  }
  return out;
}

type Marks = Array<readonly Mark[] | null>;

function unitMarks(block: Block): Marks {
  const marks: Marks = [];
  block.forEach((child) => {
    if (child.isText)
      for (let n = 0; n < (child.text?.length ?? 0); n += 1) marks.push(child.marks);
    else marks.push(null);
  });
  return marks;
}

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
    const at = a.findIndex(
      (candidate) => old.from >= candidate.start && old.to <= candidate.start + candidate.length,
    );
    if (at < 0 || a[at].key !== b[at].key) return null;
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
  key: string;
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
