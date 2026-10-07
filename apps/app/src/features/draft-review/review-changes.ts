/**
 * review-changes — the writer's list of changes under review, one per server
 * closure class, in document order.
 *
 * The server owns the class partition (dependency-closed sets of operations
 * that publish or discard together); this module only groups by the required
 * `operation.closureClassId` and describes each class: its colour, a short
 * excerpt, who made it, and whether the writer's own edits are inside it. The
 * header's stepper, the manuscript's bar and the change list all read this one
 * view-model, so they always agree on what a change is.
 *
 * Pure data, no React.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { indexOperations, isUnsplittableMerge } from "@/core/editor/extensions/inline-review";
import { type ChangeAttribution, changeAttribution } from "./change-attribution";
import {
  changeTextForOperations,
  type OperationChangeText,
  operationsWithWriterEdits,
} from "./operation-change-text";

/** The dot's colour family: AI, the writer's, an AI removal, or a merge nobody can split by author. */
export type ReviewChangeTone = "ai" | "writer" | "removal" | "merged";

export interface ReviewChange {
  /** Stable identity: the server's closure class id. */
  classId: string;
  operations: ReviewOperation[];
  /** Every operation of the class; Apply and Discard send all of them. */
  operationIds: string[];
  /** One operation to focus the change in the manuscript by. */
  anchorOperationId: string;
  tone: ReviewChangeTone;
  /** The writer's own edits are inside this change (half-and-half dot, "Includes your edits"). */
  includesWriterEdits: boolean;
  /** AI and writer edits interleaved so the text cannot be split by author. */
  merged: boolean;
  change: OperationChangeText;
  attribution: ChangeAttribution;
}

/**
 * The changes of one preview, in document order: by the earliest hunk any of a
 * change's operations owns. The server's hunks arrive in reading order; its
 * operations do not.
 */
export function reviewChanges(
  operations: readonly ReviewOperation[],
  hunks: readonly ReviewHunk[],
): ReviewChange[] {
  if (operations.length === 0) return [];
  const byClass = new Map<string, ReviewOperation[]>();
  for (const operation of operations) {
    const bucket = byClass.get(operation.closureClassId);
    if (bucket) bucket.push(operation);
    else byClass.set(operation.closureClassId, [operation]);
  }

  const firstHunk = new Map<string, number>();
  hunks.forEach((hunk, index) => {
    for (const id of hunk.operationIds) if (!firstHunk.has(id)) firstHunk.set(id, index);
  });
  const writerJoined = operationsWithWriterEdits([...operations], [...hunks]);
  const operationsById = indexOperations(operations);

  const changes = [...byClass].map(([classId, classOps]) =>
    describeChange(classId, classOps, hunks, firstHunk, writerJoined, operationsById),
  );
  const position = (change: ReviewChange) =>
    Math.min(...change.operationIds.map((id) => firstHunk.get(id) ?? Number.POSITIVE_INFINITY));
  // Array.sort is stable, so classes with no hunk keep the server's order, last.
  return changes.sort((a, b) => position(a) - position(b));
}

function describeChange(
  classId: string,
  classOps: ReviewOperation[],
  hunks: readonly ReviewHunk[],
  firstHunk: ReadonlyMap<string, number>,
  writerJoined: ReadonlySet<string>,
  operationsById: ReadonlyMap<string, ReviewOperation>,
): ReviewChange {
  const operationIds = classOps.map((op) => op.operationId);
  const ids = new Set(operationIds);
  const classHunks = hunks.filter((hunk) => hunk.operationIds.some((id) => ids.has(id)));
  const includesWriterEdits = classOps.some(
    (op) => op.kind === "writer" || writerJoined.has(op.operationId),
  );
  const merged = classHunks.some(
    (hunk) => hunk.kind === "text" && isUnsplittableMerge(hunk, operationsById),
  );
  const agentOps = classOps.filter((op) => op.kind === "agent");
  const anchorOperationId =
    [...classOps].sort(
      (a, b) =>
        (firstHunk.get(a.operationId) ?? Number.POSITIVE_INFINITY) -
        (firstHunk.get(b.operationId) ?? Number.POSITIVE_INFINITY),
    )[0]?.operationId ?? operationIds[0];
  return {
    classId,
    operations: classOps,
    operationIds,
    anchorOperationId,
    tone: merged
      ? "merged"
      : agentOps.length === 0
        ? "writer"
        : agentOps.every((op) => op.classification === "removal")
          ? "removal"
          : "ai",
    includesWriterEdits,
    merged,
    change: changeTextForOperations(classOps, [...hunks]),
    attribution: changeAttribution(classOps),
  };
}

/** The short text a row and an accessible name carry: what the change put in, else what it took out. */
export function changeExcerpt(change: ReviewChange): {
  added: string | null;
  removed: string | null;
} {
  const squash = (text: string | null) => {
    const flat = text?.replace(/\s+/g, " ").trim();
    return flat ? flat : null;
  };
  return { added: squash(change.change.added), removed: squash(change.change.removed) };
}
