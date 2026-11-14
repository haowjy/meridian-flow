// Aligns a scope's current blocks with their replacement so equal blocks stay untouched.

import type { Block } from "../codec-types.js";
import { correspond } from "../diff/correspond.js";

export type BlockAlignmentStep = { structuralBoundary?: object } & (
  | { kind: "keep"; old: number; next: number }
  | { kind: "change"; old: number; next: number }
  | { kind: "remove"; old: number }
  | { kind: "add"; next: number }
);

/**
 * Turns the blocks' correspondence into steps: an equal pair is kept, any other pair is changed in
 * place, and blocks with no counterpart are removed or added. A run of adjacent removes and adds is
 * one physical insert/delete, and a split or join (a pair with pieces beside it) shares its
 * boundary with the pieces, so the write records them as one change.
 */
export function alignBlocks(
  oldBlocks: readonly Block[],
  newBlocks: readonly Block[],
): BlockAlignmentStep[] {
  const { partner, oldPiece, nextPiece } = correspond(oldBlocks, newBlocks);
  const steps: BlockAlignmentStep[] = [];
  let [oldCursor, newCursor] = [0, 0];
  const flush = (oldEnd: number, newEnd: number) => {
    for (; oldCursor < oldEnd; oldCursor++) steps.push({ kind: "remove", old: oldCursor });
    for (; newCursor < newEnd; newCursor++) steps.push({ kind: "add", next: newCursor });
  };
  for (let old = 0; old < oldBlocks.length; old++) {
    const next = partner[old];
    if (next < 0) continue;
    flush(old, next);
    steps.push({ kind: oldBlocks[old].eq(newBlocks[next]) ? "keep" : "change", old, next });
    [oldCursor, newCursor] = [old + 1, next + 1];
  }
  flush(oldBlocks.length, newBlocks.length);

  const [joined, split] = [new Set(oldPiece), new Set(nextPiece)];
  let run: BlockAlignmentStep[] = [];
  const close = () => {
    if (run.length > 1) {
      const identity = {};
      for (const step of run) step.structuralBoundary = identity;
    }
    run = [];
  };
  for (const step of steps) {
    if (step.kind === "remove" || step.kind === "add") run.push(step);
    else {
      close();
      if (step.kind === "change" && (joined.has(step.old) || split.has(step.next))) run = [step];
    }
  }
  close();
  return steps;
}
