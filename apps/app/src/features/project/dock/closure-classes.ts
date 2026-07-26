/**
 * closure-classes — partition review operations into proposal cards (spec §5.3).
 *
 * Closure=card (ratified 2026-07-05): a server-vended Discard class renders as
 * ONE proposal card with one selective
 * Discard. The writer never sees the internal write structure; there is
 * no dependency prompt anywhere. This module turns the flat operation list the
 * preview hands us into the class partition the card list renders.
 *
 * The server owns the class partition. This client groups directly by the
 * required `operation.closureClassId`.
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
 * this view-model; its Discard acts on `primaryOperation`, which identifies the
 * server-vended Discard class spanning every operation here.
 */
export interface ReviewProposal {
  /** Stable identity for the card key + focus echo. */
  classId: string;
  /** Every operation folded into this card, in preview order. */
  operations: ReviewOperation[];
  /** The op the card's Discard runs against — it identifies the class. */
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
  // Group operations by resolved class id, preserving first-seen order both for
  // the classes and for the operations inside each class.
  const order: string[] = [];
  const groups = new Map<string, ReviewOperation[]>();
  for (const op of operations) {
    const classId = op.closureClassId;
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

function buildProposal(
  classId: string,
  classOps: ReviewOperation[],
  hunks: readonly ReviewHunk[],
  writerJoinedOps: ReadonlySet<string>,
): ReviewProposal {
  // Prefer an agent operation for the class Discard command; the server resolves
  // the representative back to the server-owned class.
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
