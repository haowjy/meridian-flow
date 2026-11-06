/**
 * Where an inline drop moves to so it never lands inside a unit the writer
 * reads as one thing: a code span, a chip (an atom, or a link that names a
 * file), a word. Pure over the document and, for an atom, the `Geometry` port.
 */

import type { Mark, Node as PMNode } from "@tiptap/pm/model";

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

/** A link that names a file or folder, as opposed to an address. */
function identityLink(node: PMNode): Mark | null {
  return node.marks.find((mark) => mark.type.name === "link" && mark.attrs.ref !== null) ?? null;
}

/** Inside inline code the landing is the span's nearer edge. */
export function snapOutOfCode(doc: PMNode, pos: number): number {
  return snapOutOf(doc, pos, codeMark);
}

export function snapOutOfIdentityLink(doc: PMNode, pos: number): number {
  return snapOutOf(doc, pos, identityLink);
}

/** A pointer over an inline atom (a mention chip) chooses its nearer side. */
export function snapOutOfAtom(doc: PMNode, pos: number, point: Point, geometry: Geometry): number {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return pos;
  const candidates = [
    { node: $pos.nodeAfter, start: pos },
    { node: $pos.nodeBefore, start: pos - ($pos.nodeBefore?.nodeSize ?? 0) },
  ];
  for (const { node, start } of candidates) {
    if (!node?.isInline || !node.isAtom || node.isText) continue;
    const box = geometry.rectOf(start);
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
    node.isText && !identityLink(node) && !codeMark(node) ? true : null,
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
