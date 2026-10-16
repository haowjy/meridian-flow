/** Shared change presentation data and failures. Open and listed bindings add their own command authority; only the open review adds focus and stepping. */

import { useMemo } from "react";
import {
  type AppliedChange,
  type DraftCommandFailure,
  type DraftRef,
  draftCommandFailure,
  pendingDraftCommand,
  sentChangeApplies,
  useDraftCommandSlice,
} from "@/client/query/draft-command-record";
import { isSameChange } from "@/core/editor/extensions/inline-review";
import type { ReviewFrame } from "./review-frame";
import type { ReviewChange } from "./review-model";
import type { MembershipRead } from "./review-runtime";
import type { VisibleChange } from "./review-visible";
import type { DiscardedEntry } from "./useHeadlessDiscards";
import { useReviewState } from "./useReviewRuntime";

const NO_ITEMS: readonly ReviewChangeItem[] = [];

export type ReviewChangeItem = VisibleChange & {
  /** A whole-draft failure, shown on the one change of a new document. */
  draftFailure?: DraftCommandFailure | null;
};

/** Presentation data can be shared without focus or command authority. */
export type DraftChangesData = {
  documentId: string | null;
  itemKey: string | null;
  /** `error`: the draft's room could not be read. Never read it as "no changes". */
  status: "idle" | "loading" | "error" | "ready" | "gone";
  items: readonly ReviewChangeItem[];
  /** A new document: its one change is the whole document, and its commands are the draft's. */
  wholeDocument: boolean;
  /** Nothing is left to review: every change was applied or discarded. Only a ready draft is finished. */
  finished: boolean;
  /** An Apply or Discard is in flight and no change is left to show; nothing is finished until it is answered. */
  completing: "apply" | "discard" | null;
  /** Read the draft again; present when `status` is `error`. */
  retry?: () => void;
};

export type DraftChangesView = DraftChangesData & {
  /** Focus belongs only to the open review interaction binding. */
  focused: ReviewChange | null;
  /** Every Apply and Discard disables on this. */
  locked: boolean;
  apply: (change: ReviewChange) => Promise<void>;
  discard: (change: ReviewChange) => Promise<unknown>;
  /** Changes discarded in place on a surface without an editor: their rows read "Discarded" with Undo. */
  discarded?: readonly DiscardedEntry[];
  undoDiscard?: (entryId: string) => void;
};

/** One row of the list, whatever state its change is in: shown as drawn, or left behind by a Discard. */
export type ChangeRow =
  | { kind: "change"; item: ReviewChangeItem }
  | { kind: "discarded"; entry: DiscardedEntry };

/**
 * The one list of rows: a change with a Discard entry (pending, discarded or failed) shows that entry in
 * its place and never also its own row; an entry whose change the projection no longer lists keeps the
 * place it sat at, so Undo brings the row back there.
 */
export function changeRows(
  items: readonly ReviewChangeItem[],
  entries: readonly DiscardedEntry[],
): ChangeRow[] {
  const owner = new Map<number, DiscardedEntry>();
  const orphans: DiscardedEntry[] = [];
  for (const { entry, change } of entries.flatMap((e) =>
    e.change ? [{ entry: e, change: e.change }] : [],
  )) {
    const at = items.findIndex(
      (item, i) => !owner.has(i) && isSameChange(change, item.change.id, item.change.pin),
    );
    if (at >= 0) owner.set(at, entry);
    else orphans.push(entry);
  }
  const rows: ChangeRow[] = [];
  items.forEach((item, index) => {
    for (const entry of orphans) if (entry.index === index) rows.push({ kind: "discarded", entry });
    const entry = owner.get(index);
    rows.push(entry ? { kind: "discarded", entry } : { kind: "change", item });
  });
  for (const entry of orphans)
    if (entry.index >= items.length) rows.push({ kind: "discarded", entry });
  return rows;
}

/** A ready new document is the file itself, not a header followed by a second named row. */
export function isWholeDocumentChange(
  view: Pick<DraftChangesData, "status" | "items" | "wholeDocument">,
): boolean {
  return view.status === "ready" && view.wholeDocument && view.items.length === 1;
}

/**
 * A draft's changes with what failed on each, minus the ones the writer applied (they left the screen at
 * the click), selected from the draft's review state while `read` (a collapsed file reads only its command
 * state, so it can still show Applying or Discarding). A draft with an Apply still out is not finished, even
 * when no change is left to show, and an Apply whose change relocated away still says it is out.
 */
export function useChangeItems(
  draft: DraftRef | null,
  { wholeDocument, read = true }: { wholeDocument: boolean; read?: boolean },
): {
  items: readonly ReviewChangeItem[];
  /** Every change of the state's frame, applied ones included. */
  changes: readonly ReviewChange[];
  frame: ReviewFrame | null;
  ready: boolean;
  membership: MembershipRead;
  /** The applied entries in force: the manuscript stops painting the changes they name. */
  applied: readonly AppliedChange[];
  completing: "apply" | "discard" | null;
} {
  const { frame, changes, ready, membership, visible, applied, unplaced } = useReviewState(
    read ? draft : null,
  );
  const records = useDraftCommandSlice(draft);
  const pending = draft ? pendingDraftCommand(records, draft) : null;
  const held = draft && wholeDocument ? draftCommandFailure(records, draft) : null;
  const items = useMemo<readonly ReviewChangeItem[]>(() => {
    if (!draft || pending) return NO_ITEMS;
    return held ? visible.map((item) => ({ ...item, draftFailure: held })) : visible;
  }, [visible, draft, pending, held]);
  const sent = draft ? sentChangeApplies(records, draft) : 0;
  return {
    items,
    changes,
    frame,
    ready,
    membership,
    applied,
    completing:
      pending?.mode ?? ((items.length === 0 && sent > 0) || unplaced > 0 ? "apply" : null),
  };
}
