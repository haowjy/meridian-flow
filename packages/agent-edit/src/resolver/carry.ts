import type { BlockRef } from "../handles.js";
import type { ProjectedBlock } from "../ports/model.js";
import type { PlainEdit, PlannedStep } from "./planned-step.js";

export interface Carried {
  steps: PlannedStep[];
  /** Set when words landed somewhere other than where the model aimed. */
  note?: string;
}

/**
 * Steps planned on `view`, the document as the model saw it, rewritten onto `now`, a later
 * document that shares block hashes (a draft opened after the model's was closed). A view block
 * is held when `now` has a block with its hash and the same content; the step touches only
 * held blocks, so a block `now` has and the view lacked is never in scope. Where a step
 * names a block `now` lacks, its words land after the nearest held block before it, or at
 * the start of the document, and its deletions have nothing to delete.
 */
export function carrySteps(
  view: readonly ProjectedBlock[],
  now: readonly ProjectedBlock[],
  steps: readonly PlannedStep[],
  document: { documentId: string; file: string },
): Carried {
  const nowIndex = new Map(now.map((block, index) => [block.fullHash, index]));
  const viewIndex = new Map(view.map((block, index) => [block.ref, index]));
  // Per view block, the index of its counterpart in `now`; undefined when gone.
  const held = view.map((block) => {
    const index = nowIndex.get(block.fullHash);
    return index !== undefined && now[index].node.eq(block.node) ? index : undefined;
  });
  let note: string | undefined;

  /**
   * The `now` block to insert after for words that stood after view block `from`, naming
   * `named` in the note when that block is gone.
   */
  const anchorAfter = (from: number, named = from): BlockRef | undefined => {
    let anchor: ProjectedBlock | undefined;
    for (let i = from; i >= 0 && !anchor; i--) {
      const index = held[i];
      if (index !== undefined) anchor = now[index];
    }
    if (held[named] === undefined && named >= 0) {
      note ??= `Block ${view[named].hash} is gone, so your text landed ${anchor ? `after ${anchor.hash}` : "at the start of the document"}, where it stood.`;
    }
    return anchor?.ref;
  };
  const indexOf = (ref: BlockRef) => viewIndex.get(ref) as number;

  /** A view scope's held blocks as runs of adjacent blocks in `now`. */
  const runsOf = (scope: readonly BlockRef[]): number[][] => {
    const runs: number[][] = [];
    for (const ref of scope) {
      const index = held[indexOf(ref)];
      if (index === undefined) continue;
      const run = runs.at(-1);
      if (run && run.at(-1) === index - 1) run.push(index);
      else runs.push([index]);
    }
    return runs;
  };
  const scopeOf = (run: readonly number[]) => ({
    kind: "range" as const,
    blocks: run.map((index) => now[index].ref),
    startIndex: run[0],
    endIndex: run[run.length - 1],
  });
  const deleteOf = (index: number): PlainEdit => ({
    ...document,
    kind: "delete",
    block: now[index].ref,
  });

  const carried: PlannedStep[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "insert":
        carried.push({
          ...step,
          after: step.after ? anchorAfter(indexOf(step.after)) : undefined,
        });
        break;
      case "edits": {
        const edits: PlainEdit[] = [];
        for (const edit of step.edits) {
          if (edit.kind === "insert") {
            const after = edit.after ? anchorAfter(indexOf(edit.after)) : undefined;
            edits.push({ ...edit, after });
          } else {
            const index = held[indexOf(edit.block)];
            if (index !== undefined) edits.push(deleteOf(index));
          }
        }
        carried.push({ kind: "edits", edits });
        break;
      }
      case "replace":
      case "spliced": {
        const blocks = step.kind === "replace" ? step.blocks : step.parsed.blocks;
        const [first, ...rest] = runsOf(step.scope.blocks);
        if (!first) {
          // Every block it rewrites is gone: its words land where the first stood.
          if (blocks.length > 0)
            carried.push({
              kind: "insert",
              after: anchorAfter(step.scope.startIndex - 1, step.scope.startIndex),
              blocks,
              assign: true,
            });
          break;
        }
        const intact =
          step.kind === "spliced" && rest.length === 0 && first.length === step.scope.blocks.length;
        carried.push(
          intact
            ? { ...step, scope: scopeOf(first) }
            : { kind: "replace", scope: scopeOf(first), blocks: [...blocks] },
        );
        // A block `now` holds between the runs stays; the later runs go.
        for (const run of rest) carried.push({ kind: "edits", edits: run.map(deleteOf) });
        break;
      }
    }
  }
  return { steps: carried, ...(note ? { note } : {}) };
}
