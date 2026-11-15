/**
 * Where an inline drop moves to so it never lands inside a unit the writer
 * reads as one thing: a code span, a chip (an atom, or a link that names a
 * file), a word. Pure over the document and, for an atom, the `Geometry` port.
 */

import { Fragment, type Mark, type Node as PMNode, Slice } from "@tiptap/pm/model";

import { chipLinkTarget } from "../links/link-chip";

import type { Geometry, Point } from "./point-landing";

type Run = { start: number; end: number };

/** Adjacent children with equal keys form one run; null keeps a child out of every run. */
type RunKey = (node: PMNode) => Mark | true | null;

function sameKey(a: Mark | true, b: Mark | true): boolean {
  return a === b || (a !== true && b !== true && a.eq(b));
}

/** The run of the textblock around `pos` that `pos` is strictly inside, or null. */
function runAround(doc: PMNode, pos: number, key: RunKey): Run | null {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  const at = $pos.parentOffset;
  const base = pos - at;
  const hits: Run[] = [];
  let run: (Run & { key: Mark | true }) | null = null;
  const close = () => {
    if (run && at > run.start && at < run.end)
      hits.push({ start: base + run.start, end: base + run.end });
    run = null;
  };
  $pos.parent.forEach((node, offset) => {
    const k = key(node);
    if (k === null) {
      close();
      return;
    }
    if (run && sameKey(run.key, k)) {
      run.end = offset + node.nodeSize;
      return;
    }
    close();
    run = { start: offset, end: offset + node.nodeSize, key: k };
  });
  close();
  return hits[0] ?? null;
}

function nearerEdge(pos: number, { start, end }: Run): number {
  return pos - start <= end - pos ? start : end;
}

function snapOutOf(doc: PMNode, pos: number, key: RunKey): number {
  const run = runAround(doc, pos, key);
  return run ? nearerEdge(pos, run) : pos;
}

const codeMark: RunKey = (node) => node.marks.find((mark) => mark.type.name === "code") ?? null;

/** A link drawn as a chip, which the writer reads as one thing. */
function chipLink(node: PMNode): Mark | null {
  return (
    node.marks.find((mark) => mark.type.name === "link" && chipLinkTarget(mark.attrs.href)) ?? null
  );
}

/** Inside inline code the landing is the span's nearer edge. */
export function snapOutOfCode(doc: PMNode, pos: number): number {
  return snapOutOf(doc, pos, codeMark);
}

/** Inside a link chip the landing is the chip's nearer edge. */
export function snapOutOfChip(doc: PMNode, pos: number): number {
  return snapOutOf(doc, pos, chipLink);
}

/**
 * The nearer edge of a code span or a link chip `pos` is inside: where a unit
 * of its own (a picture, a chip) stands so it doesn't split one in two.
 */
export function snapOutOfUnits(doc: PMNode, pos: number): number {
  return snapOutOfChip(doc, snapOutOfCode(doc, pos));
}

/**
 * Where `slice` inserted at `pos` lands, and as what. Content carrying a unit
 * of its own (a picture, a chip) goes beside a chip or code span `pos` is
 * inside. Text stays at `pos`, and strictly inside a chip it takes the chip's
 * link, as typing there does, so it edits the label instead of splitting it.
 */
export function inlineLanding(
  doc: PMNode,
  pos: number,
  slice: Slice,
): { pos: number; slice: Slice } {
  const chip = chipAround(doc, pos);
  if (carriesUnit(slice.content, chip)) return { pos: snapOutOfUnits(doc, pos), slice };
  if (!chip) return { pos, slice };
  return { pos, slice: new Slice(withMark(slice.content, chip), slice.openStart, slice.openEnd) };
}

/** The chip link on both sides of `pos`, or null at a chip's edge or outside one. */
function chipAround(doc: PMNode, pos: number): Mark | null {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock || !$pos.nodeBefore || !$pos.nodeAfter) return null;
  const before = chipLink($pos.nodeBefore);
  const after = chipLink($pos.nodeAfter);
  return before && after && before.eq(after) ? before : null;
}

// The same address counts as the same chip: the paste pipeline may give the
// pasted copy a ref the chip in the document doesn't carry yet.
function isOtherChip(link: Mark | null, around: Mark | null): boolean {
  return link !== null && !(around !== null && link.attrs.href === around.attrs.href);
}

function withMark(content: Fragment, mark: Mark): Fragment {
  const nodes: PMNode[] = [];
  content.forEach((node) => {
    if (node.isText) nodes.push(node.mark(mark.addToSet(node.marks)));
    else nodes.push(node.copy(withMark(node.content, mark)));
  });
  return Fragment.fromArray(nodes);
}

/** Text already linked to `around`'s address (a plain-text paste takes the caret's marks) is its label, not a chip. */
function carriesUnit(content: Fragment, around: Mark | null): boolean {
  let found = false;
  content.descendants((node) => {
    if (found) return false;
    found =
      (node.isInline && !node.isText && !node.type.spec.linebreakReplacement) ||
      (node.isText && isOtherChip(chipLink(node), around));
    return !found;
  });
  return found;
}

/** A pointer over an inline atom (a mention chip) chooses its nearer side. */
export function snapOutOfAtom(
  doc: PMNode,
  pos: number,
  point: Point,
  rectOf: Geometry["rectOf"],
): number {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return pos;
  const candidates = [
    { node: $pos.nodeAfter, start: pos },
    { node: $pos.nodeBefore, start: pos - ($pos.nodeBefore?.nodeSize ?? 0) },
  ];
  for (const { node, start } of candidates) {
    if (!node?.isInline || !node.isAtom || node.isText) continue;
    const box = rectOf(start);
    if (point.x < box.left || point.x > box.right || point.y < box.top || point.y > box.bottom)
      continue;
    return point.x <= (box.left + box.right) / 2 ? start : start + node.nodeSize;
  }
  return pos;
}

function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{M}\p{N}_]/u.test(character);
}

/** A pointer inside a word of plain text chooses the word's nearer edge. */
export function snapToWordEdge(doc: PMNode, pos: number): number {
  const run = runAround(doc, pos, (node) =>
    node.isText && !chipLink(node) && !codeMark(node) ? true : null,
  );
  if (!run) return pos;
  const { start, end } = run;
  const at = (index: number) => doc.textBetween(index, index + 1, "\0", "\0");
  const inWord = (index: number) =>
    isWordCharacter(at(index)) ||
    (index > start &&
      index + 1 < end &&
      /['’\-‐‑]/u.test(at(index)) &&
      isWordCharacter(at(index - 1)) &&
      isWordCharacter(at(index + 1)));
  if (!inWord(pos - 1) || !inWord(pos)) return pos;
  let before = pos;
  let after = pos;
  while (before > start && inWord(before - 1)) before -= 1;
  while (after < end && inWord(after)) after += 1;
  return pos - before <= after - pos ? before : after;
}
