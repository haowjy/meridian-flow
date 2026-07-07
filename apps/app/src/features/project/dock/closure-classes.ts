/**
 * closure-classes — partition review operations into proposal cards (spec §5.3).
 *
 * Closure=card (ratified 2026-07-05): a closure class — causal drag ∪
 * hunk-sharing as one fixpoint — renders as ONE proposal card with one Accept
 * and one Discard. The writer never sees the internal write structure; there is
 * no dependency prompt anywhere. This module turns the flat operation list the
 * preview hands us into the class partition the card list renders.
 *
 * Grouping key, richest-first:
 *   1. `operation.closureClassId` when the server vends it.
 *   2. Fallback: connected components over the accept/reject closure
 *      id sets ∪ hunk-sharing, mirroring the shipped `draft-accept-closure`
 *      precedent — so the presentation is already closure-correct before the
 *      explicit id lands.
 *
 * Pure data, no React: the card module renders whatever this returns.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";

import {
  changeTextForOperations,
  type OperationChangeText,
  operationsWithWriterEdits,
} from "./operation-change-text";

/**
 * One proposal card = one closure class. The card reads the whole class through
 * this view-model; its verbs act on `primaryOperation`, whose accept/reject
 * closure spans every operation here, so one Apply applies the class and one
 * Discard retires it.
 */
export interface ReviewProposal {
  /** Stable identity for the card key + focus echo. */
  classId: string;
  /** Every operation folded into this card, in preview order. */
  operations: ReviewOperation[];
  /** The op the card's verbs run against — its closure spans the class. */
  primaryOperation: ReviewOperation;
  /** Summary verb slot: addition / removal / rewrite across the class. */
  classification: ReviewOperation["classification"];
  /** Distinct contributing turn ids (agent authorship), for card attribution. */
  contributingTurnIds: string[];
  /** True when a writer's own edits joined this class (badge, never a prompt). */
  includesWriterEdits: boolean;
  /** True when any contributing hunk is a CRDT merge artifact (spec §6.2). */
  merged: boolean;
  /** Pooled removed/added text for the card body. */
  change: OperationChangeText;
}

/**
 * Partition operations into proposal classes. Order is stable by each class's
 * first-appearing operation, so the card list matches manuscript reading order.
 */
export function partitionClosureClasses(
  operations: readonly ReviewOperation[],
  hunks: readonly ReviewHunk[],
): ReviewProposal[] {
  if (operations.length === 0) return [];
  const classIdByOp = resolveClassIds(operations, hunks);

  // Group operations by resolved class id, preserving first-seen order both for
  // the classes and for the operations inside each class.
  const order: string[] = [];
  const groups = new Map<string, ReviewOperation[]>();
  for (const op of operations) {
    const classId = classIdByOp.get(op.operationId) ?? op.operationId;
    let bucket = groups.get(classId);
    if (!bucket) {
      bucket = [];
      groups.set(classId, bucket);
      order.push(classId);
    }
    bucket.push(op);
  }

  const writerJoinedOps = operationsWithWriterEdits(
    operations as ReviewOperation[],
    hunks as ReviewHunk[],
  );
  return order.map((classId) => {
    const classOps = groups.get(classId) ?? [];
    return buildProposal(classId, classOps, hunks, writerJoinedOps);
  });
}

/** Resolve each operation to its closure-class id (server field or fallback). */
function resolveClassIds(
  operations: readonly ReviewOperation[],
  hunks: readonly ReviewHunk[],
): Map<string, string> {
  const uf = new UnionFind();
  for (const op of operations) uf.add(op.operationId);
  const union = (ids: readonly string[]) => {
    const present = ids.filter((id) => uf.has(id));
    for (let i = 1; i < present.length; i += 1)
      uf.union(present[0] as string, present[i] as string);
  };

  const opsByExplicitClass = new Map<string, string[]>();
  for (const op of operations) {
    if (typeof op.closureClassId === "string") {
      const ids = opsByExplicitClass.get(op.closureClassId) ?? [];
      ids.push(op.operationId);
      opsByExplicitClass.set(op.closureClassId, ids);
    }
    if (op.acceptClosureOperationIds && op.acceptClosureOperationIds.length > 0) {
      union([op.operationId, ...op.acceptClosureOperationIds]);
    }
    if (op.rejectClosureOperationIds && op.rejectClosureOperationIds.length > 0) {
      union([op.operationId, ...op.rejectClosureOperationIds]);
    }
  }
  for (const ids of opsByExplicitClass.values()) union(ids);
  for (const hunk of hunks) {
    if (hunk.operationIds.length > 1) union(hunk.operationIds);
  }

  const componentOps = new Map<string, ReviewOperation[]>();
  for (const op of operations) {
    const root = uf.find(op.operationId);
    const bucket = componentOps.get(root) ?? [];
    bucket.push(op);
    componentOps.set(root, bucket);
  }

  const result = new Map<string, string>();
  for (const ops of componentOps.values()) {
    const explicitIds = new Set(
      ops.map((op) => op.closureClassId).filter((id): id is string => Boolean(id)),
    );
    const classId =
      explicitIds.size === 1
        ? ([...explicitIds][0] as string)
        : `closure:${ops
            .map((op) => op.operationId)
            .sort()
            .join("+")}`;
    for (const op of ops) result.set(op.operationId, classId);
  }
  return result;
}

function buildProposal(
  classId: string,
  classOps: ReviewOperation[],
  hunks: readonly ReviewHunk[],
  writerJoinedOps: ReadonlySet<string>,
): ReviewProposal {
  // The representative carries the class's accept/reject closure. Prefer an
  // agent op whose accept closure names the whole class; any op works when the
  // server pre-groups (each carries the same closure), so first agent op, else
  // first op, is a deterministic pick.
  const primaryOperation = classOps.find((op) => op.kind === "agent") ?? classOps[0];
  const contributingTurnIds = distinct(
    classOps.map((op) => op.actorTurnId).filter((id): id is string => Boolean(id)),
  );
  const includesWriterEdits = classOps.some(
    (op) => op.kind === "writer" || writerJoinedOps.has(op.operationId),
  );
  const classOpIds = new Set(classOps.map((op) => op.operationId));
  const merged = hunks.some(
    (hunk) => hunk.mergeArtifact === true && hunk.operationIds.some((id) => classOpIds.has(id)),
  );
  return {
    classId,
    operations: classOps,
    primaryOperation,
    classification: summaryClassification(classOps),
    contributingTurnIds,
    includesWriterEdits,
    merged,
    change: changeTextForOperations(classOps, hunks as ReviewHunk[]),
  };
}

/**
 * The class's summary verb. All-additions → addition, all-removals → removal;
 * anything mixed (or a rename/rewrite present) collapses to rewrite — the class
 * both added and removed prose, which reads as a rewrite in one glance.
 */
function summaryClassification(ops: readonly ReviewOperation[]): ReviewOperation["classification"] {
  let sawAddition = false;
  let sawRemoval = false;
  for (const op of ops) {
    if (op.classification === "addition") sawAddition = true;
    else if (op.classification === "removal") sawRemoval = true;
    else return "rewrite";
  }
  if (sawAddition && !sawRemoval) return "addition";
  if (sawRemoval && !sawAddition) return "removal";
  return "rewrite";
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Minimal union-find over operation ids for the pre-wire fallback partition. */
class UnionFind {
  private parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  has(id: string): boolean {
    return this.parent.has(id);
  }

  find(id: string): string {
    this.add(id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    // Path-compress so repeated lookups stay flat.
    let cursor = id;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor) as string;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}
