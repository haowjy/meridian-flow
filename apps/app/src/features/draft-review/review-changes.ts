/**
 * review-changes — the writer's list of changes under review, one per server
 * closure class or one whole-draft item for a new document, in document order.
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
import {
  type DraftPreviewResponse,
  operationKey,
  type ReviewHunk,
  type ReviewOperation,
} from "@meridian/contracts/drafts";
import type { ChangeSelection } from "@/client/query/draft-command-record";
import {
  attributionThreadIds,
  type ChangeAttribution,
  changeAttribution,
} from "./change-attribution";
import {
  type ChangeTextRun,
  changeTextForHunks,
  formattingChangeText,
  type OperationChangeText,
} from "./operation-change-text";
import { unattributedHunkKey } from "./review-mark-key";

/**
 * The dot's colour family: AI, the writer's, an AI removal, a merge nobody can
 * split by author, or a difference the server could not attribute at all.
 */
export type ReviewChangeTone = "ai" | "writer" | "removal" | "merged" | "unattributed";

/** The change the review's focus names: its class and the operations it held when last seen. */
export type ReviewFocus = {
  classId: string;
  operationIds: readonly string[];
  /** The operations' keys: they, not ids, find the change again after the draft is re-forked. */
  keys?: readonly string[];
};

export interface ReviewChange {
  /** Stable identity: the server's closure class id. */
  classId: string;
  operations: ReviewOperation[];
  /** Every operation of the class; Apply and Discard send all of them. */
  operationIds: string[];
  /** The same operations by `operationKey`: identity that outlives a re-fork of the draft. */
  keys: string[];
  /**
   * The one key to focus the change in the manuscript by: an operation of the
   * class, or the stand-in key of an unclassified hunk that has none.
   */
  anchorOperationId: string;
  /** Every key the manuscript paints this change's marks by. */
  markKeys: string[];
  tone: ReviewChangeTone;
  /** The writer's own edits are inside this change (half-and-half dot). */
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
   * The authorized command target. Unclassified hunks and incomplete classes
   * are display-only; only new documents authorize whole-draft disposition.
   */
  target: ChangeTarget;
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

/**
 * `reviewChanges` of a preview, derived once per preview object: the header,
 * the manuscript, the bar and the dock all read the same list, and the preview
 * (immutable, shared by the query cache) is its identity.
 */
function changesOf(preview: ActivePreview): readonly ReviewChange[] {
  let changes = reviewChanges(preview.operations, preview.hunks);
  // A draft-only document has no live target for selective commands.
  if (changes.length > 0 && preview.isNewDocument) {
    const first = changes[0];
    const attribution = preview.operations.length
      ? changeAttribution(preview.operations)
      : first.attribution;
    changes = [
      {
        ...first,
        classId: `draft:${preview.draftId}`,
        operations: [...preview.operations],
        operationIds: preview.operations.map((op) => op.operationId),
        keys: preview.operations.map(operationKey),
        markKeys: changes.flatMap((change) => change.markKeys),
        change: changeTextForHunks(preview.hunks, preview.operations),
        attribution,
        threadIds: attributionThreadIds(attribution),
        includesWriterEdits: changes.some((change) => change.includesWriterEdits),
        merged: changes.some((change) => change.merged),
        target: { kind: "draft" },
      },
    ];
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
  const held = new Set(focus.operationIds);
  const keys = new Set(focus.keys);
  return (
    changes.find(
      (change) =>
        change.operationIds.some((id) => held.has(id)) || change.keys.some((key) => keys.has(key)),
    ) ?? null
  );
}

/** A hunk the server could not attribute and that no operation owns. It has no per-change commands. */
function describeUnattributed(hunk: ReviewHunk): ReviewChange {
  const key = unattributedHunkKey(hunk.hunkId);
  return {
    classId: key,
    operations: [],
    operationIds: [],
    keys: [],
    anchorOperationId: key,
    markKeys: [key],
    tone: "unattributed",
    includesWriterEdits: false,
    merged: false,
    change: changeTextForHunks([hunk]),
    attribution: { kind: "unattributed" },
    threadIds: [],
    target: { kind: "display" },
  };
}

function describeChange(
  classId: string,
  classOps: ReviewOperation[],
  classHunks: readonly ReviewHunk[],
  firstHunk: ReadonlyMap<string, number>,
): ReviewChange {
  const operationIds = classOps.map((op) => op.operationId);
  const keys = classOps.map(operationKey);
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
    keys,
    anchorOperationId,
    markKeys: operationIds,
    target: classOps.every((op) => op.canApplyOrDiscard !== false)
      ? {
          kind: "operations",
          selection: { classIds: [classId], operationIds, keys },
        }
      : { kind: "display" },
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

/** Full excerpt runs; only the presenting row's CSS truncates their display. */
export function changeExcerpt(change: ReviewChange): ChangeTextRun[] {
  if (change.change.formatting?.length)
    return [{ kind: "added", text: change.change.formatting.map(formattingChangeText).join(". ") }];
  return change.change.runs.flatMap((run) => {
    const text = run.text.replace(/\s+/g, " ").trim();
    return text ? [{ ...run, text }] : [];
  });
}

/** The command a displayed change authorizes; synthetic display identities never become requests. */
export type ChangeTarget =
  | { kind: "operations"; selection: ChangeSelection }
  | { kind: "draft" }
  | { kind: "display" };

export type DraftView = {
  changes: readonly ReviewChange[];
};

const views = new WeakMap<ActivePreview, DraftView>();

/** One normalized change and action index, shared by open and unopened drafts. */
export function draftView(preview: ActivePreview): DraftView {
  let view = views.get(preview);
  if (!view) {
    const changes = changesOf(preview);
    view = { changes };
    views.set(preview, view);
  }
  return view;
}

/** Combine already-normalized targets, for example the changes owned by a chat. */
export function targetOfChanges(changes: readonly ReviewChange[]): ChangeTarget {
  if (changes.some((change) => change.target.kind === "draft")) return { kind: "draft" };
  const selections = changes.flatMap((change) =>
    change.target.kind === "operations" ? [change.target.selection] : [],
  );
  return selections.length
    ? {
        kind: "operations",
        selection: {
          classIds: selections.flatMap((s) => s.classIds),
          operationIds: selections.flatMap((s) => s.operationIds),
          keys: selections.flatMap((s) => s.keys ?? []),
        },
      }
    : { kind: "display" };
}

/** Lists read the normalized domain view, never reconstruct targets in a surface. */
export function reviewChangesOfPreview(preview: ActivePreview): readonly ReviewChange[] {
  return draftView(preview).changes;
}
