import * as Y from "yjs";
import type { EditOp, InsertOp, DeleteOp, ReplaceOp } from "./types";

// Internal representation before merging adjacent delete+insert pairs
interface PositionedDelete {
  kind: "delete";
  basePos: number;
  count: number;
  text: string;
}

interface PositionedInsert {
  kind: "insert";
  basePos: number;
  text: string;
}

type PositionedOp = PositionedDelete | PositionedInsert;

// Yjs text delta op shape
type YjsDeltaOp = { retain: number } | { delete: number } | { insert: string };

/**
 * Extract exact edit operations from a Yjs update applied to a base document.
 *
 * Does NOT mutate `baseDoc`. Operations are ordered by base position.
 * Returns [] for no-op updates (no changes to the observed Y.Text).
 *
 * Deleted text is recovered from the base text by position.
 * Adjacent delete+insert pairs at the same base position are merged into
 * a single `replace` operation.
 */
export function extractProposalOps(
  baseDoc: Y.Doc,
  yjsUpdate: Uint8Array,
  textKey = "content",
): EditOp[] {
  return extractProposalOpsWithClone(baseDoc, yjsUpdate, textKey).ops;
}

/**
 * Like `extractProposalOps`, but also returns the cloned doc after the update
 * has been applied. Useful when the caller also needs the proposed text without
 * cloning and applying a second time.
 */
export function extractProposalOpsWithClone(
  baseDoc: Y.Doc,
  yjsUpdate: Uint8Array,
  textKey = "content",
): { ops: EditOp[]; clonedDoc: Y.Doc } {
  // Clone to avoid mutating caller's doc
  const cloned = new Y.Doc();
  Y.applyUpdate(cloned, Y.encodeStateAsUpdate(baseDoc));

  const baseText = cloned.getText(textKey).toString();
  const ytext = cloned.getText(textKey);

  // Collect all deltas from observe events. A single applyUpdate fires
  // at most one observe event per Y.Text, but we accumulate defensively.
  const capturedDeltas: YjsDeltaOp[][] = [];
  ytext.observe((event: Y.YTextEvent) => {
    capturedDeltas.push(event.delta as YjsDeltaOp[]);
  });

  // Applying the update triggers the observer synchronously
  Y.applyUpdate(cloned, yjsUpdate);

  if (capturedDeltas.length === 0) {
    // No changes to this Y.Text
    return { ops: [], clonedDoc: cloned };
  }

  // Use the first (and normally only) delta for single-update proposals.
  // Multiple deltas from a single applyUpdate are not expected in practice.
  // capturedDeltas[0] is guaranteed by the length guard above.
  const delta = capturedDeltas[0]!;

  const positioned = deltaToPositionedOps(delta, baseText);
  return { ops: mergeAdjacentOps(positioned), clonedDoc: cloned };
}

/**
 * Convert a Yjs text delta into positioned ops against the base text.
 *
 * Retain ops advance basePos. Delete ops advance basePos and recover deleted
 * text. Insert ops do NOT advance basePos (they are insertions at the current
 * base position).
 */
function deltaToPositionedOps(
  delta: YjsDeltaOp[],
  baseText: string,
): PositionedOp[] {
  const ops: PositionedOp[] = [];
  let basePos = 0;

  for (const op of delta) {
    if ("retain" in op) {
      basePos += op.retain;
    } else if ("delete" in op) {
      const text = baseText.substring(basePos, basePos + op.delete);
      ops.push({ kind: "delete", basePos, count: op.delete, text });
      basePos += op.delete;
    } else if ("insert" in op) {
      ops.push({ kind: "insert", basePos, text: op.insert });
      // Inserts do not consume base text — do not advance basePos
    }
  }

  return ops;
}

/**
 * Merge adjacent delete+insert (or insert+delete) pairs into a single
 * `replace` operation.
 *
 * In Yjs deltas, a replace is encoded as `{delete: N}` followed immediately
 * by `{insert: S}`. After processing `{delete: N}` at basePos X, basePos
 * advances to X+N. The subsequent `{insert: S}` therefore appears at
 * basePos X+N in the positioned ops array — but it is logically a replace
 * starting at X.
 *
 * Two merge patterns handled:
 *   1. [delete at X, insert at X+count] → replace [X, X+count) (standard)
 *   2. [insert at X, delete at X]       → replace [X, X+count) (rare ordering)
 */
function mergeAdjacentOps(ops: PositionedOp[]): EditOp[] {
  const result: EditOp[] = [];
  let i = 0;

  while (i < ops.length) {
    // curr: guaranteed by while condition; next: guaranteed by bounds check.
    const curr = ops[i]!;
    const next = i + 1 < ops.length ? ops[i + 1]! : null;

    if (
      curr.kind === "delete" &&
      next !== null &&
      next.kind === "insert" &&
      // After processing {delete: count}, basePos advances to basePos+count.
      // The immediately following {insert} appears at that advanced position.
      next.basePos === curr.basePos + curr.count
    ) {
      // Standard replace: delete [X, X+N) then insert S at X
      const replace: ReplaceOp = {
        kind: "replace",
        baseStart: curr.basePos,
        baseEnd: curr.basePos + curr.count,
        deletedText: curr.text,
        insertedText: next.text,
      };
      result.push(replace);
      i += 2;
    } else if (
      curr.kind === "insert" &&
      next !== null &&
      next.kind === "delete" &&
      next.basePos === curr.basePos
    ) {
      // Rare ordering: insert S then delete [X, X+N) at same base position
      const replace: ReplaceOp = {
        kind: "replace",
        baseStart: curr.basePos,
        baseEnd: curr.basePos + next.count,
        deletedText: next.text,
        insertedText: curr.text,
      };
      result.push(replace);
      i += 2;
    } else if (curr.kind === "delete") {
      const del: DeleteOp = {
        kind: "delete",
        baseStart: curr.basePos,
        baseEnd: curr.basePos + curr.count,
        deletedText: curr.text,
      };
      result.push(del);
      i++;
    } else {
      // insert
      const ins: InsertOp = {
        kind: "insert",
        basePos: curr.basePos,
        insertedText: curr.text,
      };
      result.push(ins);
      i++;
    }
  }

  return result;
}
