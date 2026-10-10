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
import type { DraftPreviewResponse, ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { unattributedHunkKey } from "@/core/editor/extensions/inline-review";
import {
  attributionThreadIds,
  type ChangeAttribution,
  changeAttribution,
} from "./change-attribution";
import { changeTextForHunks, type OperationChangeText } from "./operation-change-text";

/**
 * The dot's colour family: AI, the writer's, an AI removal, a merge nobody can
 * split by author, or a difference the server could not attribute at all.
 */
export type ReviewChangeTone = "ai" | "writer" | "removal" | "merged" | "unattributed";

/** The change the review's focus names: its class and the operations it held when last seen. */
export type ReviewFocus = { classId: string; operationIds: readonly string[] };

export interface ReviewChange {
  /** Stable identity: the server's closure class id. */
  classId: string;
  operations: ReviewOperation[];
  /** Every operation of the class; Apply and Discard send all of them. */
  operationIds: string[];
  /**
   * The one key to focus the change in the manuscript by: an operation of the
   * class, or the stand-in key of an unclassified hunk that has none.
   */
  anchorOperationId: string;
  /** Every key the manuscript paints this change's marks by. */
  markKeys: string[];
  tone: ReviewChangeTone;
  /** The writer's own edits are inside this change (half-and-half dot, "Includes your edits"). */
  includesWriterEdits: boolean;
  /** AI and writer edits interleaved so the text cannot be split by author. */
  merged: boolean;
  change: OperationChangeText;
  attribution: ChangeAttribution;
  /**
   * Every chat with a visible agent operation in this change, latest first. A
   * change is a chat's when its id is here; the chat strip filters on it.
   */
  threadIds: string[];
  /**
   * Apply and Discard act on this change. False for an unclassified hunk with
   * no operation, and for every member of a class the server flags
   * `canApplyOrDiscard: false`; Apply draft and Discard draft handle those.
   */
  actionable: boolean;
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
  const byClass = new Map<string, ReviewOperation[]>();
  for (const operation of operations) {
    const bucket = byClass.get(operation.closureClassId);
    if (bucket) bucket.push(operation);
    else byClass.set(operation.closureClassId, [operation]);
  }

  // One pass over the hunks: where each operation first appears, and which
  // hunks each class owns (a hunk owned by operations of two classes is in both).
  const classOfOperation = new Map<string, string>();
  for (const operation of operations)
    classOfOperation.set(operation.operationId, operation.closureClassId);
  const firstHunk = new Map<string, number>();
  const hunksByClassId = new Map<string, ReviewHunk[]>();
  hunks.forEach((hunk, index) => {
    const classesOfHunk = new Set<string>();
    for (const id of hunk.operationIds) {
      if (!firstHunk.has(id)) firstHunk.set(id, index);
      const classId = classOfOperation.get(id);
      if (classId !== undefined) classesOfHunk.add(classId);
    }
    for (const classId of classesOfHunk) {
      const bucket = hunksByClassId.get(classId);
      if (bucket) bucket.push(hunk);
      else hunksByClassId.set(classId, [hunk]);
    }
  });

  const ranked = [...byClass].map(([classId, classOps]) => {
    const change = describeChange(classId, classOps, hunksByClassId.get(classId) ?? [], firstHunk);
    return {
      change,
      position: Math.min(
        ...change.operationIds.map((id) => firstHunk.get(id) ?? Number.POSITIVE_INFINITY),
      ),
    };
  });
  // A hunk no operation owns is still a difference the writer is shown: one
  // change of its own, where it sits in the document.
  hunks.forEach((hunk, index) => {
    if (hunk.operationIds.length === 0) {
      ranked.push({ change: describeUnattributed(hunk), position: index });
    }
  });
  // Classes with no hunk come last. Ties (and those) break on the class id, so
  // a refreshed preview never reshuffles changes the server happens to list in
  // another order.
  return ranked
    .sort(
      (a, b) =>
        (a.position === b.position ? 0 : a.position < b.position ? -1 : 1) ||
        a.change.classId.localeCompare(b.change.classId),
    )
    .map(({ change }) => change);
}

type ActivePreview = Extract<DraftPreviewResponse, { status: "active" }>;

const changesOfPreview = new WeakMap<ActivePreview, ReviewChange[]>();

/**
 * `reviewChanges` of a preview, derived once per preview object: the header,
 * the manuscript, the bar and the dock all read the same list, and the preview
 * (immutable, shared by the query cache) is its identity.
 */
export function reviewChangesOfPreview(preview: ActivePreview): readonly ReviewChange[] {
  let changes = changesOfPreview.get(preview);
  if (!changes) {
    changes = reviewChanges(preview.operations, preview.hunks);
    changesOfPreview.set(preview, changes);
  }
  return changes;
}

/**
 * The change a held focus now names. A class the server regrouped keeps some of
 * its operations, so when the class id is gone the change that shares an
 * operation with the focus is the same change.
 */
export function resolveFocusedChange(
  changes: readonly ReviewChange[],
  focus: ReviewFocus | null,
): ReviewChange | null {
  if (!focus) return null;
  const exact = changes.find((change) => change.classId === focus.classId);
  if (exact) return exact;
  if (focus.operationIds.length === 0) return null;
  const held = new Set(focus.operationIds);
  return changes.find((change) => change.operationIds.some((id) => held.has(id))) ?? null;
}

/** A hunk the server could not attribute and that no operation owns. It has no per-change commands. */
function describeUnattributed(hunk: ReviewHunk): ReviewChange {
  const key = unattributedHunkKey(hunk.hunkId);
  return {
    classId: key,
    operations: [],
    operationIds: [],
    anchorOperationId: key,
    markKeys: [key],
    tone: "unattributed",
    includesWriterEdits: false,
    merged: false,
    change: changeTextForHunks([hunk]),
    attribution: { kind: "unattributed" },
    threadIds: [],
    actionable: false,
  };
}

function describeChange(
  classId: string,
  classOps: ReviewOperation[],
  classHunks: readonly ReviewHunk[],
  firstHunk: ReadonlyMap<string, number>,
): ReviewChange {
  const operationIds = classOps.map((op) => op.operationId);
  const includesWriterEdits = classOps.some((op) => op.kind === "writer");
  const merged = classHunks.some((hunk) => hunk.mergeArtifact === true);
  const agentOps = classOps.filter((op) => op.kind === "agent");
  const anchorOperationId =
    [...classOps].sort(
      (a, b) =>
        (firstHunk.get(a.operationId) ?? Number.POSITIVE_INFINITY) -
        (firstHunk.get(b.operationId) ?? Number.POSITIVE_INFINITY),
    )[0]?.operationId ?? operationIds[0];
  const attribution = changeAttribution(classOps);
  return {
    classId,
    operations: classOps,
    operationIds,
    anchorOperationId,
    markKeys: operationIds,
    actionable: classOps.every((op) => op.canApplyOrDiscard !== false),
    tone: merged
      ? "merged"
      : agentOps.length === 0
        ? "writer"
        : agentOps.every((op) => op.classification === "removal")
          ? "removal"
          : "ai",
    includesWriterEdits,
    merged,
    change: changeTextForHunks(classHunks, classOps),
    attribution,
    threadIds: attributionThreadIds(attribution),
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
