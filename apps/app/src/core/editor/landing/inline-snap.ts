import { Fragment, type Mark, type Node as PMNode, Slice } from "@tiptap/pm/model";

import { chipLinkTarget } from "../links/link-chip";

import type { Geometry, Point } from "./point-landing";

type Run = { start: number; end: number };

type RunKey = (node: PMNode) => Mark | true | null;

function sameKey(a: Mark | true, b: Mark | true): boolean {
  return a === b || (a !== true && b !== true && a.eq(b));
}

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

function chipLink(node: PMNode): Mark | null {
  return (
    node.marks.find((mark) => mark.type.name === "link" && chipLinkTarget(mark.attrs.href)) ?? null
  );
}

export function snapOutOfCode(doc: PMNode, pos: number): number {
  return snapOutOf(doc, pos, codeMark);
}

export function snapOutOfChip(doc: PMNode, pos: number): number {
  return snapOutOf(doc, pos, chipLink);
}

export function snapOutOfUnits(doc: PMNode, pos: number): number {
  return snapOutOfChip(doc, snapOutOfCode(doc, pos));
}

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
