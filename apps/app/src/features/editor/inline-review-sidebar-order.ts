/**
 * Sidebar ordering + shape derivation for inline review operations.
 *
 * Pure functions only — no ProseMirror, no React. The sidebar reads absolute
 * positions from the plugin's decoration set and feeds them here to answer:
 * "in what order do operation cards appear on screen, and what honest
 *  one-line label describes each?"
 */
import type { ReviewOperation } from "@meridian/contracts/drafts";

/**
 * Minimal hunk shape the ordering logic reads. Structural so both the raw
 * server `ReviewHunk` and the plugin's `ResolvedReviewHunk` (which lives in
 * the editor extension and carries `Y.RelativePosition` anchors) satisfy it
 * without a conversion step.
 */
export interface SidebarHunkInput {
  hunkId: string;
  operationIds: string[];
  deletedText?: string;
}

/** Shape derived from an operation's own contribution — drives the writer-facing verb. */
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
  /** Text removed from live but absent in draft — kept verbatim for the
   *  sidebar's inline preview so we don't have to re-thread the raw model. */
  deletedText?: string;
}

export interface OrderedOperation {
  operation: ReviewOperation;
  /** Hunks belonging to this operation, in document order. */
  hunks: HunkResolution[];
  /** Absolute anchor position of the earliest resolvable hunk — sort key. */
  firstPos: number;
  /** Derived shape used to pick the summary verb. */
  shape: OperationShape;
  /** True when this operation itself removed text; gates deletion previews. */
  hasOwnDeletion: boolean;
  /** True when an AI operation shares at least one colored hunk with writer edits. */
  includesWriterEdits: boolean;
}

/**
 * Assemble ordered operation entries from the raw review model + resolved
 * hunk positions. Operations with no resolvable hunk are appended at the end
 * in stable input order so they stay visible instead of vanishing between
 * re-renders — the sidebar shows a fallback summary for these.
 */
export function orderOperationsForSidebar(
  operations: readonly ReviewOperation[],
  hunks: readonly SidebarHunkInput[],
  hunkPositions: ReadonlyMap<string, HunkPositionRange | null>,
): OrderedOperation[] {
  const operationsById = new Map(operations.map((op) => [op.operationId, op]));
  const mixedHunkOperationIds = new Set<string>();
  const hunksByOp = new Map<string, HunkResolution[]>();
  for (const hunk of hunks) {
    const range = hunkPositions.get(hunk.hunkId) ?? null;
    if (hunkSpansBothKinds(hunk.operationIds, operationsById)) {
      for (const opId of hunk.operationIds) mixedHunkOperationIds.add(opId);
    }

    const resolution: HunkResolution = {
      hunkId: hunk.hunkId,
      operationIds: hunk.operationIds,
      range,
      hasDeletion: Boolean(hunk.deletedText && hunk.deletedText.length > 0),
      ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
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
    const shape = deriveShape(op, sorted, mixedHunkOperationIds.has(op.operationId));
    const entry: OrderedOperation = {
      operation: op,
      hunks: sorted,
      firstPos: firstResolved?.range?.from ?? Number.POSITIVE_INFINITY,
      shape,
      hasOwnDeletion: operationHasOwnDeletion(op, sorted),
      includesWriterEdits: op.kind === "agent" && mixedHunkOperationIds.has(op.operationId),
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

function hunkSpansBothKinds(
  operationIds: readonly string[],
  operationsById: ReadonlyMap<string, ReviewOperation>,
): boolean {
  let sawAgent = false;
  let sawWriter = false;
  for (const opId of operationIds) {
    const op = operationsById.get(opId);
    if (op?.kind === "agent") sawAgent = true;
    if (op?.kind === "writer") sawWriter = true;
  }
  return sawAgent && sawWriter;
}

function deriveShape(
  operation: ReviewOperation,
  hunks: readonly HunkResolution[],
  sharesMixedHunk: boolean,
): OperationShape {
  switch (operation.contribution) {
    case "added":
      return operation.kind === "writer" && sharesMixedHunk ? "mixed" : "insert";
    case "removed":
      return "delete";
    case "rewrote":
      return "replace";
    case "edited":
      return "mixed";
  }
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

function operationHasOwnDeletion(
  operation: ReviewOperation,
  hunks: readonly HunkResolution[],
): boolean {
  if (operation.contribution) {
    return operation.contribution === "removed" || operation.contribution === "rewrote";
  }
  return hunks.some((hunk) => hunk.hasDeletion);
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
