/**
 * Sidebar ordering + shape derivation for inline review operations.
 *
 * Pure functions only — no ProseMirror, no React. The sidebar reads absolute
 * positions from the plugin's decoration set and feeds them here to answer:
 * "in what order do operation cards appear on screen, and what honest
 *  one-line label describes each?"
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";

/** Shape derived from an operation's hunks — drives the writer-facing verb. */
export type OperationShape = "insert" | "delete" | "replace" | "mixed";

export interface HunkPositionRange {
  /** Absolute draft-doc position where the hunk anchor resolves to. */
  from: number;
  /** Draft-doc end position for insertion hunks; equal to `from` for pure deletions. */
  to: number;
  /** True when the hunk carries removed text (deletion widget shown). */
  hasDeletion: boolean;
}

export interface HunkResolution {
  hunkId: string;
  operationIds: string[];
  range: HunkPositionRange | null;
  hasDeletion: boolean;
}

export interface OrderedOperation {
  operation: ReviewOperation;
  /** Hunks belonging to this operation, in document order. */
  hunks: HunkResolution[];
  /** Absolute anchor position of the earliest resolvable hunk — sort key. */
  firstPos: number;
  /** Derived shape used to pick the summary verb. */
  shape: OperationShape;
}

/**
 * Assemble ordered operation entries from the raw review model + resolved
 * hunk positions. Operations with no resolvable hunk are appended at the end
 * in stable input order so they stay visible instead of vanishing between
 * re-renders — the sidebar shows a fallback summary for these.
 */
export function orderOperationsForSidebar(
  operations: readonly ReviewOperation[],
  hunks: readonly ReviewHunk[],
  hunkPositions: ReadonlyMap<string, HunkPositionRange | null>,
): OrderedOperation[] {
  const hunksByOp = new Map<string, HunkResolution[]>();
  for (const hunk of hunks) {
    const range = hunkPositions.get(hunk.hunkId) ?? null;
    const resolution: HunkResolution = {
      hunkId: hunk.hunkId,
      operationIds: hunk.operationIds,
      range,
      hasDeletion: Boolean(hunk.deletedText && hunk.deletedText.length > 0),
    };
    for (const opId of hunk.operationIds) {
      const list = hunksByOp.get(opId);
      if (list) list.push(resolution);
      else hunksByOp.set(opId, [resolution]);
    }
  }

  const positioned: OrderedOperation[] = [];
  const unpositioned: OrderedOperation[] = [];

  for (const op of operations) {
    const raw = hunksByOp.get(op.operationId) ?? [];
    const sorted = raw.slice().sort((a, b) => rangeSortKey(a.range) - rangeSortKey(b.range));

    const firstResolved = sorted.find((h) => h.range != null);
    const shape = deriveShape(sorted);
    const entry: OrderedOperation = {
      operation: op,
      hunks: sorted,
      firstPos: firstResolved?.range?.from ?? Number.POSITIVE_INFINITY,
      shape,
    };
    if (firstResolved) positioned.push(entry);
    else unpositioned.push(entry);
  }

  positioned.sort((a, b) => a.firstPos - b.firstPos);
  return [...positioned, ...unpositioned];
}

/** Rank order for pure-deletion hunks that share a position with an anchor. */
function rangeSortKey(range: HunkPositionRange | null): number {
  return range == null ? Number.POSITIVE_INFINITY : range.from;
}

function deriveShape(hunks: readonly HunkResolution[]): OperationShape {
  if (hunks.length === 0) return "mixed";
  let sawInsertOnly = false;
  let sawDeleteOnly = false;
  let sawReplace = false;
  for (const hunk of hunks) {
    const insertion = hunk.range != null && hunk.range.to > hunk.range.from;
    const deletion = hunk.hasDeletion;
    if (insertion && deletion) sawReplace = true;
    else if (insertion) sawInsertOnly = true;
    else if (deletion) sawDeleteOnly = true;
  }
  const kinds = [sawInsertOnly, sawDeleteOnly, sawReplace].filter(Boolean).length;
  if (kinds !== 1) return "mixed";
  if (sawInsertOnly) return "insert";
  if (sawDeleteOnly) return "delete";
  return "replace";
}

/**
 * Group entries by adjacency for the "comment queue" visual grouping — two
 * operations whose first hunks land inside the same block boundary (measured
 * by an at-block-level position resolver the caller supplies) render as
 * adjacent cards with no gap.
 *
 * The block-boundary resolver takes an absolute position and returns a stable
 * block key (e.g., the parent node's absolute start). Passing `null` returns
 * everything as one group per entry — used by tests that don't need real
 * ProseMirror geometry.
 */
export function groupAdjacentEntries(
  entries: readonly OrderedOperation[],
  blockKeyForPos: ((pos: number) => number | null) | null,
): OrderedOperation[][] {
  if (entries.length === 0) return [];
  if (!blockKeyForPos) return entries.map((entry) => [entry]);

  const groups: OrderedOperation[][] = [];
  let currentBlockKey: number | null = null;
  let currentGroup: OrderedOperation[] | null = null;
  for (const entry of entries) {
    const blockKey = Number.isFinite(entry.firstPos) ? blockKeyForPos(entry.firstPos) : null;
    if (blockKey != null && blockKey === currentBlockKey && currentGroup) {
      currentGroup.push(entry);
      continue;
    }
    currentGroup = [entry];
    groups.push(currentGroup);
    currentBlockKey = blockKey;
  }
  return groups;
}
